// Shrinks a receipt photo before storing it: max 1600px on the long side, JPEG ~70%.
// That keeps receipts readable at roughly 150–350 KB each.
const MAX_SIDE = 1600;
const QUALITY = 0.72;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a photo the app can read')); };
    img.src = url;
  });
}

export async function compressPhoto(file) {
  const img = await loadImage(file); // browsers apply the photo's rotation (EXIF) automatically
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => { canvas.toBlob(resolve, 'image/jpeg', QUALITY); });
  return { data: await blob.arrayBuffer(), type: 'image/jpeg' };
}

export const photoUrl = (photo) => URL.createObjectURL(new Blob([photo.data], { type: photo.type }));
