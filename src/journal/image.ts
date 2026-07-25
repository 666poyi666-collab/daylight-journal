/** Compress a selected image; rejection leaves the current journal unchanged. */
export function resizeJournalImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const objectUrl = URL.createObjectURL(file)
    image.onload = () => {
      URL.revokeObjectURL(objectUrl)
      try {
        const maxEdge = 1280
        const scale = Math.min(1, maxEdge / Math.max(image.width, image.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(image.width * scale))
        canvas.height = Math.max(1, Math.round(image.height * scale))
        const context = canvas.getContext('2d')
        if (!context) {
          reject(new Error('Canvas unavailable'))
          return
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/jpeg', 0.78))
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Image conversion failed'))
      }
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('Image decode failed'))
    }
    image.src = objectUrl
  })
}
