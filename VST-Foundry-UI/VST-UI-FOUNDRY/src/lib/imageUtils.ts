export const removeImageBackground = (
  imageUrl: string, 
  tolerance: number = 30,
  targetColorHex?: string,
  feathering: number = 0
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error("No context"));

      try {
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;

        let targetR = data[0];
        let targetG = data[1];
        let targetB = data[2];

        if (targetColorHex) {
          const hex = targetColorHex.replace('#', '');
          if (hex.length === 6) {
            targetR = parseInt(hex.substring(0, 2), 16);
            targetG = parseInt(hex.substring(2, 4), 16);
            targetB = parseInt(hex.substring(4, 6), 16);
          }
        }

        for (let i = 0; i < data.length; i += 4) {
          const pr = data[i];
          const pg = data[i + 1];
          const pb = data[i + 2];
          const pa = data[i + 3];

          if (pa === 0) continue;

          // Calculate distance
          const distance = Math.sqrt(
            Math.pow(pr - targetR, 2) +
            Math.pow(pg - targetG, 2) +
            Math.pow(pb - targetB, 2)
          );

          if (distance < tolerance) {
            data[i + 3] = 0; // Set alpha to 0
          } else if (feathering > 0 && distance < tolerance + feathering) {
            // Feathering calculation
            const factor = (distance - tolerance) / feathering;
            data[i + 3] = Math.floor(pa * factor);
          }
        }

        ctx.putImageData(imageData, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      } catch (err) {
        reject(new Error(`Image processing failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    };
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = imageUrl;
  });
};
