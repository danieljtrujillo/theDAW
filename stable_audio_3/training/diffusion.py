import math
import pytorch_lightning as pl
import torch
import typing as tp

from einops import rearrange
from safetensors.torch import save_file
from functools import partial
from torch.nn import functional as F

from ..inference.sampling import truncated_logistic_normal_rescaled, sample_timesteps_logsnr, sample_timesteps_logsnr_uniform
from ..models.diffusion import ConditionedDiffusionModelWrapper
from ..models.inpainting import random_inpaint_mask
from ..models.lora import add_lora, get_lora_params, get_lora_state_dict, LoRAParametrization, get_lora_layers, save_lora_safetensors, resolve_adapter_type, prepare_dora_state_dict, cast_base_to_precision
from .utils import create_optimizer_from_config, create_scheduler_from_config, log_metric, create_augmented_padding_mask, compute_masked_loss, compute_normalized_mse, resize_padding_mask, StaggeredLogger
from time import time

class Profiler:

    def __init__(self):
        self.ticks = [[time(), None]]

    def tick(self, msg):
        self.ticks.append([time(), msg])

    def __repr__(self):
        rep = 80 * "=" + "\n"
        for i in range(1, len(self.ticks)):
            msg = self.ticks[i][1]
            ellapsed = self.ticks[i][0] - self.ticks[i - 1][0]
            rep += msg + f": {ellapsed*1000:.2f}ms\n"
        rep += 80 * "=" + "\n\n\n"
        return rep

class DiffusionCondTrainingWrapper(pl.LightningModule):
    '''
    Wrapper for training a conditional audio diffusion model.
    '''
    def __init__(
            self,
            model: ConditionedDiffusionModelWrapper,
            lr: float = None,
            mask_loss_weight: float = 0.0,
            mask_padding_attention: bool = False,
            silence_extension_scale_seconds: float = 0.0,
            use_ema: bool = True,
            log_loss_info: bool = False,
            optimizer_configs: dict = None,
            pre_encoded: bool = False,
            cfg_dropout_prob = 0.1,
            timestep_sampler: tp.Literal["uniform", "logit_normal", "trunc_logit_normal", "log_snr", "log_snr_uniform"] = "uniform",
            timestep_sampler_options: tp.Optional[tp.Dict[str, tp.Any]] = None,
            validation_timesteps = [0.1, 0.3, 0.5, 0.7, 0.9],
            p_one_shot: float = 0.0,
            inpainting_config: dict = None,
            use_effective_length_for_schedule: bool = False,
            sample_rate: int = 44100,
            sample_size: int = None,
            loss_normalization: tp.Literal["none", "timestep", "sample", "sample_channel"] = "none",
            loss_norm_eps: float = 1e-6,
            lora_config: tp.Optional[tp.Dict[str, tp.Any]] = None,
            lora_state_dict: tp.Optional[tp.Dict[str, tp.Any]] = None,
            svd_bases_path: tp.Optional[str] = None,
            log_every_n_steps: int = 10,
            ot_coupling: bool = False,
            base_precision: tp.Optional[str] = None,
    ):
        super().__init__()

        self.ot_coupling = ot_coupling

        self.diffusion = model

        self.lora_config = lora_config
        if self.lora_config is not None:
            # Don't use EMA with LoRA
            use_ema = False
            # Freeze the pre-trained model weights
            self.diffusion.model.eval().requires_grad_(False)
            self.diffusion.conditioner.eval().requires_grad_(False)
            rank = self.lora_config.get("rank", 8)
            lora_alpha = self.lora_config.get("alpha", rank)
            adapter_type = self.lora_config.get("adapter_type", "lora")
            include = self.lora_config.get("include", None)
            exclude = self.lora_config.get("exclude", None)
            # Resolve legacy "dora" to rows/cols variant
            adapter_type = resolve_adapter_type(adapter_type, lora_state_dict)
            print(f"LoRA config: rank={rank}, alpha={lora_alpha}, adapter_type={adapter_type}")
            if include:
                print(f"  include: {include}")
            if exclude:
                print(f"  exclude: {exclude}")
            # Load pre-computed SVD bases for -XS adapter types
            svd_bases = None
            if svd_bases_path is not None:
                print(f"Loading SVD bases from {svd_bases_path}")
                svd_bases = torch.load(svd_bases_path, map_location="cpu", weights_only=True)
            elif adapter_type.endswith("-xs"):
                print("WARNING: -XS adapter without svd_bases_path — SVD will be computed per layer")
            lora_config = {
                torch.nn.Linear: {
                    "weight": partial(LoRAParametrization.from_linear, rank=rank, lora_alpha=lora_alpha, adapter_type=adapter_type),
                },
                torch.nn.Conv1d: {
                    "weight": partial(LoRAParametrization.from_conv1d, rank=rank, lora_alpha=lora_alpha, adapter_type=adapter_type),
                }
            }
            # Add LoRA to the model
            add_lora(self.diffusion.model, lora_config, include=include, exclude=exclude, svd_bases=svd_bases)
            # Add LoRA to the conditioner
            add_lora(self.diffusion.conditioner, lora_config, include=include, exclude=exclude, svd_bases=svd_bases)
            print("lora layers:", len(get_lora_layers(self.diffusion)))

            if lora_state_dict is not None:
                # Old DoRA checkpoints saved magnitude as 2D (1,fan_in) or (fan_out,1);
                # current code expects 1D. Squeeze so old checkpoints still load.
                prepare_dora_state_dict(lora_state_dict)
                self.diffusion.model.load_state_dict(lora_state_dict, strict=False)
                self.diffusion.conditioner.load_state_dict(lora_state_dict, strict=False)

            # Cast frozen base weights to lower precision if requested
            if base_precision:
                cast_base_to_precision(self.diffusion.model, base_precision)
                cast_base_to_precision(self.diffusion.conditioner, base_precision)
                if self.diffusion.pretransform is not None:
                    self.diffusion.pretransform.to(
                        torch.bfloat16 if base_precision in ("bf16", "bfloat16") else torch.float16
                    )

        self.diffusion_ema = None
        self.mask_loss_weight = mask_loss_weight

        # Attention masking for padded tokens
        # Backward compat: if passed from training config, propagate to model
        if mask_padding_attention and not self.diffusion.mask_padding_attention:
            import warnings
            warnings.warn("mask_padding_attention in training config is deprecated. Move to model.diffusion config.", FutureWarning)
            self.diffusion.mask_padding_attention = mask_padding_attention
        self.mask_padding_attention = self.diffusion.mask_padding_attention
        self.silence_extension_scale_seconds = silence_extension_scale_seconds

        self.cfg_dropout_prob = cfg_dropout_prob

        self.rng = torch.quasirandom.SobolEngine(1, scramble=True)

        self.timestep_sampler = timestep_sampler     

        self.timestep_sampler_options = {} if timestep_sampler_options is None else timestep_sampler_options

        if self.timestep_sampler == "log_snr":
            self.mean_logsnr = self.timestep_sampler_options.get("mean_logsnr", -1.2)
            self.std_logsnr = self.timestep_sampler_options.get("std_logsnr", 2.0)
        elif self.timestep_sampler == "log_snr_uniform":
            self.min_logsnr = self.timestep_sampler_options.get("min_logsnr", -6.0)
            self.max_logsnr = self.timestep_sampler_options.get("max_logsnr", 5.0)

        self.p_one_shot = p_one_shot

        self.diffusion_objective = model.diffusion_objective

        self.log_loss_info = log_loss_info

        self._staggered_logger = StaggeredLogger(every_n_steps=log_every_n_steps)

        assert lr is not None or optimizer_configs is not None, "Must specify either lr or optimizer_configs in training config"

        if optimizer_configs is None:
            optimizer_configs = {
                "diffusion": {
                    "optimizer": {
                        "type": "Adam",
                        "config": {
                            "lr": lr
                        }
                    }
                }
            }
        else:
            if lr is not None:
                print(f"WARNING: learning_rate and optimizer_configs both specified in config. Ignoring learning_rate and using optimizer_configs.")

        self.optimizer_configs = optimizer_configs

        self.pre_encoded = pre_encoded

        # Loss normalization by target magnitude
        # Options: "none", "timestep", "sample", "sample_channel"
        self.loss_normalization = loss_normalization
        self.loss_norm_eps = loss_norm_eps

        # Inpainting
        self.inpainting_config = inpainting_config
        
        if self.inpainting_config is not None:
            self.inpaint_mask_kwargs = self.inpainting_config.get("mask_kwargs", {})

        # Per-element schedule shift based on effective (unpadded) sequence length
        # Backward compat: if passed from training config, propagate to model
        if use_effective_length_for_schedule and not self.diffusion.use_effective_length_for_schedule:
            import warnings
            warnings.warn("use_effective_length_for_schedule in training config is deprecated. Move to model.diffusion config.", DeprecationWarning)
            self.diffusion.use_effective_length_for_schedule = use_effective_length_for_schedule
        self.use_effective_length_for_schedule = self.diffusion.use_effective_length_for_schedule
        self.sample_rate = sample_rate
        self.sample_size = sample_size

        # FSDP
        self.use_fsdp = False

        # Validation
        self.validation_timesteps = validation_timesteps

        self.validation_step_outputs = {}

        for validation_timestep in self.validation_timesteps:
            self.validation_step_outputs[f'val/loss_{validation_timestep:.1f}'] = []

    def configure_optimizers(self):
        diffusion_opt_config = self.optimizer_configs['diffusion']

        if self.lora_config is not None:
            opt_params = [*get_lora_params(self.diffusion.model), *get_lora_params(self.diffusion.conditioner)]
        elif diffusion_opt_config['optimizer'].get('type') == 'MuonAdamW':
            # Pass (name, param) tuples so MuonAdamW can match fused layer patterns
            opt_params = [(n, p) for n, p in self.diffusion.named_parameters() if p.requires_grad]
        else:
            # Only include parameters that require gradients (excludes frozen pretransform, conditioner, etc.)
            opt_params = [p for p in self.diffusion.parameters() if p.requires_grad]

        opt_diff = create_optimizer_from_config(diffusion_opt_config['optimizer'], opt_params)

        if "scheduler" in diffusion_opt_config:
            sched_diff = create_scheduler_from_config(diffusion_opt_config['scheduler'], opt_diff)
            sched_diff_config = {
                "scheduler": sched_diff,
                "interval": "step"
            }
            return [opt_diff], [sched_diff_config]

        return [opt_diff]

    def training_step(self, batch, batch_idx):
        reals, metadata = batch

        p = Profiler()

        if reals.ndim == 4 and reals.shape[0] == 1:
            reals = reals[0]

        diffusion_input = reals

        p.tick("setup")

        #with torch.amp.autocast(device_type="cuda"):
        conditioning = self.diffusion.conditioner(metadata, self.device)

        # Create batch tensor of padding masks from the metadata
        # If padding_mask not provided, assume all positions are valid (no padding)
        if all("padding_mask" in md for md in metadata):
            padding_masks = torch.stack([md["padding_mask"][0] for md in metadata], dim=0).to(self.device)  # Shape (batch_size, sequence_length)
        else:
            # All-True mask: everything is signal, no padding
            padding_masks = torch.ones(diffusion_input.shape[0], diffusion_input.shape[-1], dtype=torch.bool, device=self.device)

        p.tick("conditioning")

        if self.diffusion.pretransform is not None:
            self.diffusion.pretransform.to(self.device)

            if not self.pre_encoded:
                with torch.cuda.amp.autocast(), torch.set_grad_enabled(self.diffusion.pretransform.enable_grad):
                    self.diffusion.pretransform.train(self.diffusion.pretransform.enable_grad)
                    diffusion_input = self.diffusion.pretransform.encode(diffusion_input)
                    p.tick("pretransform")
                    padding_masks = resize_padding_mask(padding_masks, diffusion_input.shape[-1])
            else:
                # Apply scale to pre-encoded latents if needed, as the pretransform encode function will not be run
                if hasattr(self.diffusion.pretransform, "scale") and self.diffusion.pretransform.scale != 1.0:
                    diffusion_input = diffusion_input / self.diffusion.pretransform.scale


                if padding_masks.shape[-1] != diffusion_input.shape[-1]:
                    padding_masks = resize_padding_mask(padding_masks, diffusion_input.shape[-1])

        if self.timestep_sampler == "uniform":
            # Draw uniformly distributed continuous timesteps
            t = self.rng.draw(reals.shape[0])[:, 0].to(self.device)
        elif self.timestep_sampler == "logit_normal":
            t = torch.sigmoid(torch.randn(reals.shape[0], device=self.device))
        elif self.timestep_sampler == "trunc_logit_normal":
            # Draw from logistic truncated normal distribution
            t = truncated_logistic_normal_rescaled(reals.shape[0]).to(self.device)

            # Flip the distribution
            t = 1 - t
        elif self.timestep_sampler == "log_snr":
            t = sample_timesteps_logsnr(reals.shape[0], mean_logsnr=self.mean_logsnr, std_logsnr=self.std_logsnr).to(self.device)
        elif self.timestep_sampler == "log_snr_uniform":
            t = sample_timesteps_logsnr_uniform(reals.shape[0], min_logsnr=self.min_logsnr, max_logsnr=self.max_logsnr).to(self.device)
        else:
            raise ValueError(f"Invalid timestep_sampler: {self.timestep_sampler}")

        if self.diffusion.dist_shift is not None:
            # Compute sequence length for schedule shift
            if self.use_effective_length_for_schedule:
                # Use per-element effective lengths derived from seconds_total (rounded up)
                # This matches inference which computes effective length from seconds_total conditioning
                # Fall back to padding_masks.sum() if seconds_total is not available
                if all("seconds_total" in md for md in metadata):
                    downsampling_ratio = self.diffusion.pretransform.downsampling_ratio if self.diffusion.pretransform is not None else 1
                    effective_seq_len = torch.tensor(
                        [int(math.ceil(int(md["seconds_total"] * self.sample_rate) / downsampling_ratio)) for md in metadata],
                        device=self.device
                    )
                else:
                    # Fallback: use padding mask sum
                    effective_seq_len = padding_masks.sum(dim=-1)
            else:
                # Use total sequence length (original behavior)
                effective_seq_len = diffusion_input.shape[2]
            
            # Shift the distribution
            t = self.diffusion.dist_shift.shift(t, effective_seq_len)

        if self.p_one_shot > 0:
            # Set t to 1 with probability p_one_shot
            t = torch.where(torch.rand_like(t) < self.p_one_shot, torch.ones_like(t), t)

        # Calculate the noise schedule parameters for those timesteps
        if self.diffusion_objective in ["rectified_flow", "rf_denoiser"]:
            alphas, sigmas = 1-t, t

        # Combine the ground truth data and the noise
        alphas = alphas[:, None, None]
        sigmas = sigmas[:, None, None]
        noise = torch.randn_like(diffusion_input)

        # Minibatch OT coupling: find optimal noise permutation for straighter transport paths
        # Based on MelodyFlow (arXiv:2407.03648v2) Section 2.5.2
        # Uses GPU-only Sinkhorn approximation to avoid CPU sync
        if self.ot_coupling and diffusion_input.shape[0] > 1:
            with torch.no_grad():
                # Flatten to [batch, features] for distance computation
                data_flat = diffusion_input.reshape(diffusion_input.shape[0], -1)
                noise_flat = noise.reshape(noise.shape[0], -1)
                # Squared L2 cost via matmul (faster than cdist, same optimal assignment)
                aa = (data_flat * data_flat).sum(dim=1, keepdim=True)
                bb = (noise_flat * noise_flat).sum(dim=1, keepdim=True)
                cost_matrix = aa + bb.T - 2.0 * (data_flat @ noise_flat.T)
                # Sinkhorn assignment (GPU-only, no CPU sync)
                log_P = -cost_matrix / cost_matrix.detach().mean() # normalize for numerical stability
                for _ in range(20):
                    log_P = log_P - torch.logsumexp(log_P, dim=1, keepdim=True)
                    log_P = log_P - torch.logsumexp(log_P, dim=0, keepdim=True)
                # Sequential assignment from soft permutation matrix (guarantees valid permutation)
                P = log_P.exp()
                B = P.shape[0]
                col_indices = torch.empty(B, dtype=torch.long, device=P.device)
                used = torch.zeros(B, dtype=torch.bool, device=P.device)
                for i in range(B):
                    P[i, used] = -1
                    col_indices[i] = P[i].argmax()
                    used[col_indices[i]] = True
                noise = noise[col_indices]

        noised_inputs = diffusion_input * alphas + noise * sigmas

        if self.diffusion_objective == "v":
            targets = noise * alphas - diffusion_input * sigmas
        elif self.diffusion_objective in ["rectified_flow", "rf_denoiser"]:
            targets = noise - diffusion_input

        p.tick("noise")

        extra_args = {}

        # Compute downsampling ratio for attention mask creation
        downsampling_ratio = self.diffusion.pretransform.downsampling_ratio if self.diffusion.pretransform is not None else 1

        # Create augmented padding mask with random silence extension
        if self.mask_padding_attention and self.silence_extension_scale_seconds > 0:
            augmented_padding_mask = create_augmented_padding_mask(
                padding_masks,
                silence_extension_scale_seconds=self.silence_extension_scale_seconds,
                sample_rate=self.sample_rate,
                downsampling_ratio=downsampling_ratio,
            )
        else:
            augmented_padding_mask = padding_masks

        # Loss mask defines signal vs padding regions for loss computation
        # - mask_loss_weight controls padding contribution (0 = signal only)
        # - When mask_padding_attention=True: only compute loss on signal (padding saw no attention)
        loss_mask = augmented_padding_mask.to(torch.bool)

        # Pass padding mask for attention masking - model handles prepend extension
        if self.mask_padding_attention:
            extra_args["padding_mask"] = augmented_padding_mask

        if self.inpainting_config is not None:

            # Max mask size is the full sequence length
            max_mask_length = diffusion_input.shape[2]

            # Create a mask of random length for a random slice of the input
            inpaint_masked_input, inpaint_mask = random_inpaint_mask(diffusion_input, padding_masks=augmented_padding_mask, mask_padding=self.mask_padding_attention, **self.inpaint_mask_kwargs)

            conditioning['inpaint_mask'] = [inpaint_mask]
            conditioning['inpaint_masked_input'] = [inpaint_masked_input]

            # Only compute loss on inpainted region (where model is generating)
            loss_mask = loss_mask & ~inpaint_mask.squeeze(1).to(torch.bool)

        output = self.diffusion(noised_inputs, t, cond=conditioning, cfg_dropout_prob = self.cfg_dropout_prob, **extra_args)
        p.tick("diffusion")

        if self.log_loss_info:
            # Loss debugging logs
            num_loss_buckets = 10
            bucket_size = 1 / num_loss_buckets
            loss_all = F.mse_loss(output, targets, reduction="none")

            sigmas = rearrange(self.all_gather(sigmas), "w b c n -> (w b) c n").squeeze()

            # gather loss_all across all GPUs
            loss_all = rearrange(self.all_gather(loss_all), "w b c n -> (w b) c n")

            # Bucket loss values based on corresponding sigma values, bucketing sigma values by bucket_size
            loss_all = torch.stack([loss_all[(sigmas >= i) & (sigmas < i + bucket_size)].mean() for i in torch.arange(0, 1, bucket_size).to(self.device)])

            # Log bucketed losses with corresponding sigma bucket values, if it's not NaN
            debug_log_dict = {
                f"model/loss_all_{i/num_loss_buckets:.1f}": loss_all[i].detach() for i in range(num_loss_buckets) if not torch.isnan(loss_all[i])
            }

            self.log_dict(debug_log_dict)

        p.tick("loss_debug")

        # Compute std only over non-padded positions when masking is active
        if loss_mask is not None and self.mask_padding_attention:
            mask_expanded = loss_mask.unsqueeze(1)  # [B, 1, T]
            std_data = diffusion_input[mask_expanded.expand_as(diffusion_input)].std()
            std_targets = targets[mask_expanded.expand_as(targets)].std().detach()
        else:
            std_data = diffusion_input.std()
            std_targets = targets.std().detach()

        log_dict = {
            'train/std_data': std_data,
            'train/std_targets': std_targets,
            'train/lr': self.trainer.optimizers[0].param_groups[0]['lr']
        }

        p.tick("std_compute")

        # Compute normalized MSE (normalization only affects non-"none" modes)
        mse_loss_full = compute_normalized_mse(output, targets, loss_mask, self.loss_normalization, self.loss_norm_eps)

        p.tick("mse_loss")

        # Compute loss with signal/padding separation (returns already-detached metrics)
        loss, signal_mean, padding_mean = compute_masked_loss(
            mse_loss_full, loss_mask, self.mask_padding_attention, self.mask_loss_weight
        )
        mse_loss = loss

        p.tick("masked_loss")

        # When attention masking is on, compute_masked_loss excludes everything outside
        # loss_mask (which now excludes inpaint context). Add context reconstruction loss
        # so the model learns to preserve context regions during inpainting.
        # (When mask_padding_attention=False, context is already included via mask_loss_weight.)
        context_loss_mean = torch.tensor(0.0, device=loss.device)
        if (self.inpainting_config is not None
                and self.mask_padding_attention
                and self.mask_loss_weight > 0):
            # Context = inpaint_mask=1 (keep) AND padding_mask=1 (real audio, not padding)
            inpaint_context = inpaint_mask.squeeze(1).to(torch.bool) & augmented_padding_mask.to(torch.bool)
            n_ctx = inpaint_context.sum(dim=1) * mse_loss_full.shape[1]  # per-sample count
            if n_ctx.sum() > 0:
                context_vals = torch.where(inpaint_context.unsqueeze(1), mse_loss_full, 0.0)
                context_loss_mean = (context_vals.sum(dim=(1, 2)) / (n_ctx + 1e-8)).mean()
                loss = loss + context_loss_mean * self.mask_loss_weight

        # Log separate signal/padding/context losses for monitoring
        log_dict["train/mse_signal"] = signal_mean
        log_dict["train/mse_masked_loss"] = padding_mean
        log_dict["train/mse_context_loss"] = context_loss_mean.detach()

        log_dict["train/mse_loss"] = mse_loss.detach()
        log_dict["train/loss"] = loss.detach()

        # Stash for external callbacks (e.g. loss-by-timestep logging)
        self._last_t = t.detach()
        self._last_per_elem_loss = mse_loss_full.detach().mean(dim=(1, 2))

        self._staggered_logger.log(log_dict, self)

        #p.tick("log_dict")
        #print(f"Profiler: {p}")
        return loss

    def validation_step(self, batch, batch_idx):

        reals, metadata = batch

        if reals.ndim == 4 and reals.shape[0] == 1:
            reals = reals[0]

        diffusion_input = reals

        with torch.amp.autocast("cuda"), torch.no_grad():
            conditioning = self.diffusion.conditioner(metadata, self.device)

        # Create batch tensor of padding masks from the metadata
        if all("padding_mask" in md for md in metadata):
            padding_masks = torch.stack([md["padding_mask"][0] for md in metadata], dim=0).to(self.device)
        else:
            padding_masks = torch.ones(diffusion_input.shape[0], diffusion_input.shape[-1], dtype=torch.bool, device=self.device)

        if self.diffusion.pretransform is not None:
            self.diffusion.pretransform.to(self.device)

            if not self.pre_encoded:
                with torch.amp.autocast("cuda"), torch.no_grad():
                    self.diffusion.pretransform.train(self.diffusion.pretransform.enable_grad)
                    diffusion_input = self.diffusion.pretransform.encode(diffusion_input)
                    padding_masks = resize_padding_mask(padding_masks, diffusion_input.shape[-1])
            else:
                # Apply scale to pre-encoded latents if needed, as the pretransform encode function will not be run
                if hasattr(self.diffusion.pretransform, "scale") and self.diffusion.pretransform.scale != 1.0:
                    diffusion_input = diffusion_input / self.diffusion.pretransform.scale

                if padding_masks.shape[-1] != diffusion_input.shape[-1]:
                    padding_masks = resize_padding_mask(padding_masks, diffusion_input.shape[-1])

        # Use padding mask directly for validation (no silence extension augmentation)
        loss_mask = padding_masks.to(torch.bool)

        extra_args = {}
        if self.mask_padding_attention:
            extra_args["padding_mask"] = padding_masks

        # Set up inpainting conditioning for validation (FULL_MASK: all zeros)
        if self.inpainting_config is not None:
            inpaint_mask = torch.zeros(diffusion_input.shape[0], 1, diffusion_input.shape[2], device=self.device)
            inpaint_masked_input = torch.zeros_like(diffusion_input)
            conditioning['inpaint_mask'] = [inpaint_mask]
            conditioning['inpaint_masked_input'] = [inpaint_masked_input]

        for validation_timestep in self.validation_timesteps:

            t = torch.full((reals.shape[0],), validation_timestep, device=self.device)

            # Calculate the noise schedule parameters for those timesteps
            if self.diffusion_objective in ["v"]:
                alphas, sigmas = get_alphas_sigmas(t)
            elif self.diffusion_objective in ["rectified_flow", "rf_denoiser"]:
                alphas, sigmas = 1-t, t

            # Combine the ground truth data and the noise
            alphas = alphas[:, None, None]
            sigmas = sigmas[:, None, None]
            noise = torch.randn_like(diffusion_input)
            noised_inputs = diffusion_input * alphas + noise * sigmas

            if self.diffusion_objective == "v":
                targets = noise * alphas - diffusion_input * sigmas
            elif self.diffusion_objective in ["rectified_flow", "rf_denoiser"]:
                targets = noise - diffusion_input

            with torch.amp.autocast("cuda"), torch.no_grad():
                output = self.diffusion(noised_inputs, t, cond=conditioning, cfg_dropout_prob = 0, **extra_args)

                mse_loss_full = compute_normalized_mse(output, targets, loss_mask, self.loss_normalization, self.loss_norm_eps)
                val_loss, _, _ = compute_masked_loss(
                    mse_loss_full, loss_mask, self.mask_padding_attention, self.mask_loss_weight
                )

                self.validation_step_outputs[f'val/loss_{validation_timestep:.1f}'].append(val_loss.item())

    def on_validation_epoch_end(self):
        log_dict = {}
        for validation_timestep in self.validation_timesteps:
            outputs_key = f'val/loss_{validation_timestep:.1f}'
            val_loss = sum(self.validation_step_outputs[outputs_key]) / len(self.validation_step_outputs[outputs_key])

            # Gather losses across all GPUs
            val_loss = self.all_gather(val_loss).mean().item()

            log_metric(self.logger, outputs_key, val_loss, step=self.global_step)

        # Get average over all timesteps
        val_loss = torch.tensor([val for val in self.validation_step_outputs.values()]).mean()

        # Gather losses across all GPUs
        val_loss = self.all_gather(val_loss).mean().item()

        log_metric(self.logger, 'val/avg_loss', val_loss, step=self.global_step)

        # Reset validation losses
        for validation_timestep in self.validation_timesteps:
            self.validation_step_outputs[f'val/loss_{validation_timestep:.1f}'] = []


    def export_model(self, path, use_safetensors=False):
        if self.diffusion_ema is not None:
            self.diffusion.model = self.diffusion_ema.ema_model

        if use_safetensors:
            save_file(self.diffusion.state_dict(), path)
        else:
            torch.save({"state_dict": self.diffusion.state_dict()}, path)

    def export_lora_safetensors(self, path):
        """Export LoRA weights as a safetensors file with embedded config."""
        if self.lora_config is None:
            raise ValueError("No LoRA config -- this wrapper is not in LoRA mode")
        state_dict = {
            **get_lora_state_dict(self.diffusion.model),
            **get_lora_state_dict(self.diffusion.conditioner)
        }
        save_lora_safetensors(state_dict, self.lora_config, path)

    def on_save_checkpoint(self, checkpoint):
        if self.lora_config is not None:
            checkpoint.clear()
            checkpoint['state_dict'] = {
                **get_lora_state_dict(self.diffusion.model),
                **get_lora_state_dict(self.diffusion.conditioner)
            }
            checkpoint['lora_config'] = self.lora_config