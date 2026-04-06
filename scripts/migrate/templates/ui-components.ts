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

  files["src/components/ui/Picture.tsx"] = `import type { ReactNode } from "react";
import {
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

export function Source(props: PictureSourceProps & { fit?: FitOptions }) {
  const srcSet = getSrcSet(props.src, props.width, props.height, props.fit ?? "cover");
  return (
    <source
      srcSet={srcSet}
      media={props.media}
      width={props.width}
      height={props.height}
      sizes={props.sizes ?? \`\${props.width}px\`}
    />
  );
}

export function Picture({
  sources,
  src,
  width,
  height,
  fit = "cover",
  preload,
  children,
  ...rest
}: PictureProps & { children?: ReactNode }) {
  return (
    <picture>
      {children ?? sources?.map((source, i) => (
        <Source key={i} {...source} fit={source.fit ?? fit} />
      ))}
      {src && <Image src={src} width={width} height={height} fit={fit} preload={preload} {...rest} />}
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

  files["src/components/ui/Seo.tsx"] = `export interface Props {
  title?: string;
  description?: string;
  canonical?: string;
  image?: string;
  noIndexing?: boolean;
  jsonLDs?: unknown[];
}

export default function Seo({ jsonLDs }: Props) {
  if (!jsonLDs?.length) return null;

  return (
    <>
      {jsonLDs.map((jsonLD, i) => (
        <script
          key={i}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLD) }}
        />
      ))}
    </>
  );
}
`;

  return files;
}
