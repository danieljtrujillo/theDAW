#!/bin/bash
#SBATCH --partition=p5en-small
#SBATCH --job-name=smoke_pre_encode
#SBATCH --nodes=1
#SBATCH --gpus=1
#SBATCH --ntasks=1
#SBATCH --ntasks-per-node=1
#SBATCH --output=/weka2/home-mrice/outs/%x_%j.out
#SBATCH --account sai_audio

export SLURM_MPI_TYPE=none

cd /weka2/home-mrice/stable-audio-3
uv run python scripts/pre_encode_dataset.py \
    --model same-s \
    --data_dir /weka2/home-mrice/datasets/mshoxxDB_processed \
    --output_path /weka2/home-mrice/datasets/smoke_test_latents \
    --batch_size 1 \
    --no_pad
