declare module '*.css';
// Bundled as data: URLs (webpack.renderer.config.ts).
declare module '*.wav' {
  const src: string;
  export default src;
}
