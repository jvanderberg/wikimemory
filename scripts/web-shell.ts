const ROOT_CONTAINER = /<div\s+id=["']root["'][^>]*>/u;
const MODULE_ASSET = /<script\s+[^>]*type=["']module["'][^>]*src=["']\/assets\//u;

export function isReactApplicationShell(html: string): boolean {
  return ROOT_CONTAINER.test(html) && MODULE_ASSET.test(html);
}
