/**
 * Project icons drawn on a canvas, for browser tests that frame artwork: the
 * shapes real favicons come in, as PNG data URLs and as `projects.readIcon`
 * results.
 */
export type ArtworkSample =
  | "tile"
  | "square"
  | "circle"
  | "darkGlyph"
  | "whiteGlyph"
  | "shadowTile"
  | "mattedTile"
  | "inkDisc";

const SIDE = 64;
const PURPLE = "#7c3aed";

const DRAW: Record<ArtworkSample, (context: CanvasRenderingContext2D) => void> = {
  // The user's icon: a purple rounded square with a white "S" and a transparent margin.
  tile: (context) => {
    context.fillStyle = PURPLE;
    context.beginPath();
    context.roundRect(8, 8, 48, 48, 11);
    context.fill();
    letter(context, "#ffffff");
  },
  square: (context) => {
    context.fillStyle = PURPLE;
    context.fillRect(0, 0, SIDE, SIDE);
    letter(context, "#ffffff");
  },
  circle: (context) => {
    context.fillStyle = "#0ea5e9";
    context.beginPath();
    context.arc(SIDE / 2, SIDE / 2, SIDE / 2, 0, Math.PI * 2);
    context.fill();
    letter(context, "#ffffff");
  },
  darkGlyph: (context) => letter(context, "#18181b"),
  whiteGlyph: (context) => letter(context, "#ffffff"),
  // A macOS-style app icon: the tile casts a soft drop shadow into its margin.
  shadowTile: (context) => {
    context.shadowColor = "rgba(0, 0, 0, 0.45)";
    context.shadowBlur = 6;
    context.shadowOffsetY = 3;
    context.fillStyle = PURPLE;
    context.beginPath();
    context.roundRect(10, 8, 44, 44, 10);
    context.fill();
    context.shadowColor = "transparent";
    letter(context, "#ffffff", 30, 30);
  },
  // An exported favicon: the tile sits small on an opaque white square.
  mattedTile: (context) => {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, SIDE, SIDE);
    context.fillStyle = PURPLE;
    context.beginPath();
    context.roundRect(18, 18, 28, 28, 6);
    context.fill();
    letter(context, "#ffffff", 20);
  },
  // A Next.js-style mark: a black disc with a white letter, dark as the island.
  inkDisc: (context) => {
    context.fillStyle = "#000000";
    context.beginPath();
    context.arc(SIDE / 2, SIDE / 2, SIDE / 2, 0, Math.PI * 2);
    context.fill();
    letter(context, "#ffffff");
  },
};

function letter(context: CanvasRenderingContext2D, color: string, size = 40, centerY = SIDE / 2) {
  context.fillStyle = color;
  context.font = `bold ${size}px sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("S", SIDE / 2, centerY + size / 20);
}

export function artworkDataUrl(sample: ArtworkSample): string {
  const canvas = document.createElement("canvas");
  canvas.width = SIDE;
  canvas.height = SIDE;
  DRAW[sample](canvas.getContext("2d")!);
  return canvas.toDataURL("image/png");
}

/** The sample as the node returns it from `projects.readIcon`. */
export function artworkIcon(sample: ArtworkSample) {
  return {
    mimeType: "image/png",
    dataBase64: artworkDataUrl(sample).slice("data:image/png;base64,".length),
  };
}

export async function loadArtworkImage(sample: ArtworkSample): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = artworkDataUrl(sample);
  await image.decode();
  return image;
}
