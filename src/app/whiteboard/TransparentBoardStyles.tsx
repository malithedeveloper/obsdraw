export default function TransparentBoardStyles() {
  return (
    <style>{`
      :root, html, body, #__next, main, [data-whiteboard-root] {
        background: transparent !important;
        background-color: transparent !important;
        margin: 0 !important;
        padding: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        overflow: visible !important;
      }
      * {
        scrollbar-width: none !important;
        -ms-overflow-style: none !important;
      }
      *::-webkit-scrollbar {
        width: 0 !important;
        height: 0 !important;
      }
      canvas {
        background: transparent !important;
        background-color: transparent !important;
        display: block !important;
      }
      video, img {
        opacity: 1 !important;
        visibility: visible !important;
      }
      [style*="left: -99999px"] { left: 0 !important; }
      [style*="top: -99999px"] { top: 0 !important; }
      [style*="overflow: hidden"] { overflow: visible !important; }
    `}</style>
  );
}
