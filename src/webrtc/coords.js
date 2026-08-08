// Map a pointer position on the client's rendered <video> element to page CSS
// coordinates. Assumes the video is displayed at the page's aspect ratio
// (client sets video to width:100%, height:auto, so no letterboxing).
export function mapClientToPage({ clientX, clientY, displayW, displayH, pageW, pageH }) {
  return {
    x: Math.round((clientX / displayW) * pageW),
    y: Math.round((clientY / displayH) * pageH),
  };
}
