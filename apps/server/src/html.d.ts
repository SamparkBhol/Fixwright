// wrangler "Text" rule: importing a view's .html gives its contents as a string.
declare module '*.html' {
  const html: string;
  export default html;
}
