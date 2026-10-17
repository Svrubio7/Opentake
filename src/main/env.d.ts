// electron-vite: "file?asset" imports a file as its path on disk (copied next to the bundle).
declare module "*?asset" {
  const path: string;
  export default path;
}
