export function generateId() {
  return "asset_" + Math.random().toString(36).substr(2, 6);
}

// Helper to extract a crop from an image and return base64
export function extractCrop(
  imageElement: HTMLImageElement,
  xmin: number,
  ymin: number,
  xmax: number,
  ymax: number
): string {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  if (!ctx) return "";

  const sx = xmin * imageElement.naturalWidth;
  const sy = ymin * imageElement.naturalHeight;
  const sWidth = (xmax - xmin) * imageElement.naturalWidth;
  const sHeight = (ymax - ymin) * imageElement.naturalHeight;

  canvas.width = sWidth;
  canvas.height = sHeight;

  ctx.drawImage(
    imageElement,
    sx, sy, sWidth, sHeight,
    0, 0, sWidth, sHeight
  );

  return canvas.toDataURL("image/png");
}

export async function trimTransparentPixels(
  dataUrl: string,
  originalXmin: number,
  originalYmin: number,
  originalWidth: number, // in pixels of the full image
  originalHeight: number // in pixels of the full image
): Promise<{ trimmedDataUrl: string, xmin: number, ymin: number, xmax: number, ymax: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(null);

      ctx.drawImage(img, 0, 0);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imgData.data;

      let minX = canvas.width;
      let minY = canvas.height;
      let maxX = 0;
      let maxY = 0;
      let found = false;

      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const alpha = data[(y * canvas.width + x) * 4 + 3];
          if (alpha > 5) { // threshold for not fully transparent
            found = true;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      if (!found) {
        return resolve(null);
      }

      const trimmedWidth = maxX - minX + 1;
      const trimmedHeight = maxY - minY + 1;

      const trimmedCanvas = document.createElement("canvas");
      trimmedCanvas.width = trimmedWidth;
      trimmedCanvas.height = trimmedHeight;
      const trimmedCtx = trimmedCanvas.getContext("2d");
      if (!trimmedCtx) return resolve(null);

      trimmedCtx.drawImage(
        canvas,
        minX, minY, trimmedWidth, trimmedHeight,
        0, 0, trimmedWidth, trimmedHeight
      );

      const trimmedDataUrl = trimmedCanvas.toDataURL("image/png");

      // Calculate new relative coordinates
      const newXmin = originalXmin + (minX / originalWidth);
      const newYmin = originalYmin + (minY / originalHeight);
      const newXmax = originalXmin + (maxX / originalWidth);
      const newYmax = originalYmin + (maxY / originalHeight);

      resolve({ trimmedDataUrl, xmin: newXmin, ymin: newYmin, xmax: newXmax, ymax: newYmax });
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

export async function applyPolygonMask(imageUrl: string, polygon: any[]): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(imageUrl);

      if (polygon && polygon.length > 2) {
        ctx.beginPath();
        const firstPoint = polygon[0];
        const firstX = Array.isArray(firstPoint) ? firstPoint[0] : firstPoint.x;
        const firstY = Array.isArray(firstPoint) ? firstPoint[1] : firstPoint.y;
        ctx.moveTo(firstX * img.width, firstY * img.height);
        for (let i = 1; i < polygon.length; i++) {
          const point = polygon[i];
          const px = Array.isArray(point) ? point[0] : point.x;
          const py = Array.isArray(point) ? point[1] : point.y;
          ctx.lineTo(px * img.width, py * img.height);
        }
        ctx.closePath();
        ctx.clip();
      }

      ctx.drawImage(img, 0, 0);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => resolve(imageUrl);
    img.src = imageUrl;
  });
}
