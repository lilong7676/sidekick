declare module "*.html" {
  const bundle: import("bun").HTMLBundle;
  export default bundle;
}

declare module "*.md" {
  const text: string;
  export default text;
}

declare module "*.yaml" {
  const text: string;
  export default text;
}
