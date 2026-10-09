// Next's asset pipeline returns { src } for a static import (like images); used for the one font preload in layout.tsx (#855).
declare module '*.woff2' {
  const asset: { src: string };
  export default asset;
}
