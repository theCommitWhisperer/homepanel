declare const __HOMEPANEL_VERSION__: string | undefined;
/** HomePanel release version (apps/desktop/package.json), injected by the bundler. */
export const VERSION: string = typeof __HOMEPANEL_VERSION__ === "string" ? __HOMEPANEL_VERSION__ : "0.0.0-dev";
