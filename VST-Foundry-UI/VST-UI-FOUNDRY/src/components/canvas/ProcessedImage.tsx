import React, { useState, useEffect } from "react";
import { UIElement, Asset, Texture } from "../../types";
import { removeImageBackground } from "../../lib/imageUtils";

export const ProcessedImage = ({
  el,
  asset,
  texture,
}: {
  el: UIElement;
  asset: Asset;
  texture?: Texture;
}) => {
  const [processedUrl, setProcessedUrl] = useState<string>(asset.url);
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    let active = true;
    const processImage = async () => {
      if (el.imageModifiers?.removeBg) {
        setIsProcessing(true);
        try {
          const url = await removeImageBackground(
            asset.url,
            el.imageModifiers.tolerance,
            el.imageModifiers.targetColor,
            el.imageModifiers.feathering,
          );
          if (active) {
            setProcessedUrl(url);
            setIsProcessing(false);
          }
        } catch (e) {
          console.error("Failed to process image", e);
          if (active) {
            setProcessedUrl(asset.url);
            setIsProcessing(false);
          }
        }
      } else {
        setProcessedUrl(asset.url);
        setIsProcessing(false);
      }
    };
    processImage();
    return () => {
      active = false;
      setIsProcessing(false);
    };
  }, [
    asset.url,
    el.imageModifiers?.removeBg,
    el.imageModifiers?.tolerance,
    el.imageModifiers?.feathering,
    el.imageModifiers?.targetColor,
  ]);

  const showGlow = el.glow;
  const opacityPct = el.opacity ?? 100;

  const baseStyle: React.CSSProperties = {
    "--base-color": el.transparentBackground
      ? "transparent"
      : `color-mix(in srgb, ${el.baseColor || "#121116"} ${opacityPct}%, transparent)`,
    "--active-color": `color-mix(in srgb, ${el.activeColor || "#a855f7"} ${opacityPct}%, transparent)`,
    "--text-color": el.textColor || "#f8fafc",
    "--border-color": `color-mix(in srgb, ${el.borderColor || "#221f2e"} ${opacityPct}%, transparent)`,
    "--indicator-color": `color-mix(in srgb, ${el.indicatorColor || "var(--active-color)"} ${opacityPct}%, transparent)`,
  } as any;

  const gColor = el.glowColor || "var(--active-color)";
  const gStyle = el.glowStyle || "solid";
  const gOpacity = el.glowOpacity !== undefined ? el.glowOpacity / 100 : 1;
  const gSpread = el.glowSpread !== undefined ? el.glowSpread : 10;
  const blur = (el.glowAmount ?? 50) / 2;
  const spread = gSpread;

  // Setup outer filter style if outer/solid/neon glow is enabled
  const isOuter = showGlow && (gStyle === "outer" || gStyle === "solid" || gStyle === "neon" || !gStyle);
  const isTransparent = el.transparentBackground || el.imageModifiers?.removeBg;

  const containerFilter = isOuter && isTransparent
    ? `drop-shadow(0 0 ${blur + spread}px ${gColor})`
    : undefined;

  const containerBoxShadow = isOuter && !isTransparent
    ? `0 0 ${blur}px ${spread}px ${gColor}`
    : undefined;

  const effectClass =
    el.effect === "pulsing"
      ? "animate-pulse"
      : el.effect === "orbital"
        ? "animate-[spin_3s_linear_infinite]"
        : el.effect === "audioReactive"
          ? "animate-bounce"
          : el.effect === "breathing"
            ? "animate-slow-breath"
            : el.effect === "flickering"
              ? "animate-neon-flicker"
              : el.effect === "floating"
                ? "animate-bob-float"
                : "";

  const roundedClass = el.cornerRadius ? "" : "rounded";

  return (
    <div
      className={`w-full h-full relative ${effectClass} ${roundedClass} transition-shadow duration-300`}
      style={{
        ...baseStyle,
        filter: containerFilter,
        boxShadow: containerBoxShadow,
        borderRadius: el.cornerRadius ? `${el.cornerRadius}px` : undefined,
      }}
    >
      {/* Center Glow / Back Glow layer */}
      {showGlow && (gStyle === "center" || gStyle === "radial") && (
        <div
          className="absolute pointer-events-none rounded-full"
          style={{
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: `calc(100% + ${spread * 2}px)`,
            height: `calc(100% + ${spread * 2}px)`,
            background: `radial-gradient(circle, ${gColor} 0%, color-mix(in srgb, ${gColor} 30%, transparent) 60%, transparent 100%)`,
            opacity: gOpacity,
            filter: `blur(${blur || 1}px)`,
            zIndex: 0,
          }}
        />
      )}

      {/* Main image */}
      <img
        src={processedUrl}
        alt={el.name}
        className={`w-full h-full object-cover rounded-[inherit] pointer-events-none transition-opacity ${isProcessing ? "opacity-50" : "opacity-100"}`}
        style={{
          position: 'relative',
          zIndex: 1,
        }}
      />

      {/* Inner Glow masked overlay */}
      {showGlow && gStyle === "inner" && (
        <div
          className="absolute inset-0 pointer-events-none rounded-[inherit]"
          style={{
            maskImage: `url(${processedUrl})`,
            WebkitMaskImage: `url(${processedUrl})`,
            maskSize: "cover",
            WebkitMaskSize: "cover",
            maskPosition: "center",
            WebkitMaskPosition: "center",
            maskRepeat: "no-repeat",
            WebkitMaskRepeat: "no-repeat",
            boxShadow: `inset 0 0 ${blur}px ${spread}px ${gColor}`,
            opacity: gOpacity,
            zIndex: 2,
          }}
        />
      )}

      {texture && (
        <div
          className="absolute inset-0 overflow-hidden pointer-events-none rounded-[inherit]"
          style={{
            maskImage: `url(${processedUrl})`,
            WebkitMaskImage: `url(${processedUrl})`,
            maskSize: "cover",
            WebkitMaskSize: "cover",
            maskPosition: "center",
            WebkitMaskPosition: "center",
            maskRepeat: "no-repeat",
            WebkitMaskRepeat: "no-repeat",
            mixBlendMode: (el.textureBlendMode as any) || "normal",
            zIndex: 3,
          }}
        >
          <div
            className="w-full h-full origin-center"
            style={{
              backgroundImage: `url(${texture.url})`,
              backgroundSize: el.textureSize || "cover",
              backgroundPosition: `calc(50% + ${el.textureOffsetX || 0}px) calc(50% + ${el.textureOffsetY || 0}px)`,
              backgroundRepeat: el.textureRepeat || "no-repeat",
              opacity: (el.textureOpacity ?? 100) / 100,
              transform: `scale(${(el.textureScale ?? 100) / 100}) rotate(${el.textureRotation || 0}deg)`,
            }}
          />
        </div>
      )}

      {isProcessing && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/20 rounded" style={{ zIndex: 4 }}>
          <div className="w-4 h-4 border-2 border-app-accent border-t-transparent rounded-full animate-spin" />
        </div>
      )}
    </div>
  );
};
