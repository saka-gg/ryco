import assets from "./screenshotAssets.json";

/** Only known product captures have generated variants; arbitrary images keep their URL. */
export function screenshotImageProps(src: string, sizes = "(max-width: 768px) 100vw, 1200px") {
  const asset = (
    assets as Record<string, { src: string; srcSet: string; width: number; height: number }>
  )[src];
  return asset ? { ...asset, sizes } : { src };
}
