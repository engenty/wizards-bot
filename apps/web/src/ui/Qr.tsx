// From engenty wizards, apps/web/src/studio/editor/WizardQr.tsx (`qrSvg`, `QrImage`, `QrCode`).
import { useMemo } from "react";
import { renderSVG } from "uqr";
import { cn } from "./index";

/** A QR code of a text, on white whatever the theme: a camera reads dark on light. */
export function QrCode({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const svg = useMemo(() => renderSVG(text, { ecc: "M", border: 2, pixelSize: 8 }), [text]);
  return (
    <div
      role="img"
      aria-label={label}
      className={cn("size-40 overflow-hidden rounded-xl bg-white p-1 [&>svg]:size-full", className)}
      // uqr writes the SVG from the text alone: no markup of anyone else's goes in.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: generated from the text only
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
