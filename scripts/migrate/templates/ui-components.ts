import type { MigrationContext } from "../types.ts";

export function generateUiComponents(_ctx: MigrationContext): Record<string, string> {
  const files: Record<string, string> = {};

  files["src/components/ui/Image.tsx"] = `export {
  Image as default,
  Image,
  getOptimizedMediaUrl,
  getSrcSet,
  registerImageCdnDomain,
  getImageCdnDomain,
  FACTORS,
  type ImageProps,
  type FitOptions,
} from "@decocms/apps/commerce/components/Image";
`;

  files["src/components/ui/Picture.tsx"] = `import {
  Image,
  getSrcSet,
  type FitOptions,
  type ImageProps,
} from "@decocms/apps/commerce/components/Image";

export interface PictureSourceProps {
  src: string;
  width: number;
  height?: number;
  media: string;
  fit?: FitOptions;
  sizes?: string;
}

export interface PictureProps extends Omit<ImageProps, "sizes"> {
  sources: PictureSourceProps[];
}

export function Picture({
  sources,
  src,
  width,
  height,
  fit = "cover",
  preload,
  ...rest
}: PictureProps) {
  return (
    <picture>
      {sources.map((source, i) => {
        const srcSet = getSrcSet(source.src, source.width, source.height, source.fit ?? fit);
        return (
          <source
            key={i}
            srcSet={srcSet}
            media={source.media}
            width={source.width}
            height={source.height}
            sizes={source.sizes ?? \`\${source.width}px\`}
          />
        );
      })}
      <Image src={src} width={width} height={height} fit={fit} preload={preload} {...rest} />
    </picture>
  );
}
`;

  files["src/components/ui/Video.tsx"] = `interface Props {
  src: string;
  width?: number;
  height?: number;
  autoPlay?: boolean;
  muted?: boolean;
  loop?: boolean;
  playsInline?: boolean;
  controls?: boolean;
  className?: string;
  loading?: "lazy" | "eager";
  poster?: string;
}

export default function Video({
  src,
  width,
  height,
  autoPlay = true,
  muted = true,
  loop = true,
  playsInline = true,
  controls = false,
  className,
  poster,
}: Props) {
  return (
    <video
      src={src}
      width={width}
      height={height}
      autoPlay={autoPlay}
      muted={muted}
      loop={loop}
      playsInline={playsInline}
      controls={controls}
      className={className}
      poster={poster}
    />
  );
}
`;

  return files;
}
