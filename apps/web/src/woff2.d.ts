// What a static import of a font evaluates to depends on the bundler (a URL string here, { src } elsewhere), so it is typed `unknown` and read through `assetUrl` (#855).
declare module '*.woff2' {
  const asset: unknown;
  export default asset;
}
