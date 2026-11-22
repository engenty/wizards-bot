// From engenty wizards, packages/runner/src/camera.tsx: one photo, no clips.
import { Camera, Flashlight, FlashlightOff, SwitchCamera, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { isTouch } from "../lib/device";
import { t } from "../lib/i18n";
import { cn, Spinner } from "./index";

type Facing = "environment" | "user";
/** Why there is no picture: the person (or the browser) said no, there is no camera, or it is in use. */
type CameraError = "denied" | "missing" | "busy";

function cameraError(err: unknown): CameraError {
  const name = (err as DOMException)?.name;
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "missing";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "busy";
  }
  return "denied";
}

/** The phone's light, where the camera track has one (Chrome on Android). */
function hasTorch(track: MediaStreamTrack | undefined): boolean {
  const capabilities = track?.getCapabilities?.() as { torch?: boolean } | undefined;
  return Boolean(capabilities?.torch);
}

/**
 * The device's camera as a live picture, for as long as `active`. The browser asks for the
 * camera when this starts, so callers open it from the person's tap.
 */
function useCameraStream(active: boolean, facing: Facing) {
  const video = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<CameraError | null>(null);
  const [cameras, setCameras] = useState(1);
  const [torchable, setTorchable] = useState(false);
  const [torch, setTorchOn] = useState(false);

  useEffect(() => {
    if (!active) {
      return;
    }
    let live: MediaStream | null = null;
    let stopped = false;
    setError(null);
    setStream(null);
    setTorchable(false);
    setTorchOn(false);
    const start = async () => {
      live = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facing }, width: { ideal: 2560 }, height: { ideal: 1440 } },
      });
      if (stopped) {
        for (const track of live.getTracks()) {
          track.stop();
        }
        return;
      }
      setStream(live);
      const track = live.getVideoTracks()[0];
      // Phones report the torch a moment after the picture starts.
      const readTorch = () => !stopped && setTorchable(hasTorch(track));
      readTorch();
      setTimeout(readTorch, 600);
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      if (!stopped) {
        setCameras(devices.filter((d) => d.kind === "videoinput").length);
      }
    };
    start().catch((err) => !stopped && setError(cameraError(err)));
    return () => {
      stopped = true;
      for (const track of live?.getTracks() ?? []) {
        track.stop();
      }
    };
  }, [active, facing]);

  useEffect(() => {
    if (video.current && stream) {
      video.current.srcObject = stream;
    }
  }, [stream]);

  const setTorch = async (on: boolean) => {
    const track = stream?.getVideoTracks()[0];
    try {
      await track?.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      setTorchOn(on);
    } catch {
      setTorchable(false);
    }
  };
  const mirrored = stream?.getVideoTracks()[0]?.getSettings().facingMode === "user";
  return { video, stream, error, cameras, torchable, torch, setTorch, mirrored };
}

/** The camera: the whole screen on a phone, a centred sheet on a desk. */
function MediaSheet({
  open,
  onClose,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    if (open && !el.open) {
      el.showModal();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-label={label} className="media-sheet">
      {open ? <div className="flex h-full flex-col">{children}</div> : null}
    </dialog>
  );
}

function SheetButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex size-11 shrink-0 items-center justify-center rounded-full transition",
        active ? "bg-white text-black" : "bg-white/12 text-white hover:bg-white/20",
      )}
    >
      {children}
    </button>
  );
}

function SheetAction({
  onClick,
  quiet,
  children,
}: {
  onClick: () => void;
  quiet?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-11 items-center justify-center gap-2 rounded-full px-5 font-medium text-[0.875rem] transition",
        quiet ? "text-white/75 hover:text-white" : "bg-white text-black hover:bg-white/90",
      )}
    >
      {children}
    </button>
  );
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

/**
 * Takes a photo with the device's camera: front or back camera, and the torch where the device
 * has one. `onNative` is the way on when the browser gives no camera: the phone's own camera
 * app, or a photo that is there already.
 */
export function CameraDialog({
  open,
  selfie,
  onClose,
  onCapture,
  onNative,
}: {
  open: boolean;
  /** Starts with the camera that faces the person. */
  selfie?: boolean;
  onClose: () => void;
  onCapture: (file: File) => void;
  onNative: () => void;
}) {
  const [facing, setFacing] = useState<Facing>(selfie ? "user" : "environment");
  const camera = useCameraStream(open, facing);

  const shoot = async () => {
    const el = camera.video.current;
    if (!el?.videoWidth) {
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = el.videoWidth;
    canvas.height = el.videoHeight;
    canvas.getContext("2d")?.drawImage(el, 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    if (blob) {
      onCapture(new File([blob], `photo-${stamp()}.jpg`, { type: "image/jpeg" }));
      onClose();
    }
  };

  return (
    <MediaSheet open={open} onClose={onClose} label={t("composer.photo")}>
      <div className="safe-top">
        <div className="flex items-center gap-2 px-3 py-2">
          <SheetButton label={t("common.close")} onClick={onClose}>
            <X className="size-5" />
          </SheetButton>
          <div className="min-w-0 flex-1 truncate text-center font-medium text-[0.9375rem]">
            {t("composer.photo")}
          </div>
          {camera.torchable ? (
            <SheetButton
              label={t("camera.torch")}
              active={camera.torch}
              onClick={() => void camera.setTorch(!camera.torch)}
            >
              {camera.torch ? (
                <Flashlight className="size-5" />
              ) : (
                <FlashlightOff className="size-5" />
              )}
            </SheetButton>
          ) : null}
          {camera.stream && (camera.cameras > 1 || isTouch) ? (
            <SheetButton
              label={t("camera.flip")}
              onClick={() => setFacing((f) => (f === "environment" ? "user" : "environment"))}
            >
              <SwitchCamera className="size-5" />
            </SheetButton>
          ) : (
            <span className="size-11" />
          )}
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <video
          ref={camera.video}
          autoPlay
          playsInline
          muted
          className={cn(
            "absolute inset-0 size-full object-contain",
            camera.mirrored && "-scale-x-100",
          )}
        />
        {camera.error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-black px-8 text-center">
            <p className="max-w-sm text-[0.9375rem] text-white/85 leading-relaxed">
              {t(`camera.${camera.error}`)}
            </p>
            <div className="flex flex-col gap-2">
              <SheetAction
                onClick={() => {
                  onClose();
                  onNative();
                }}
              >
                <Camera className="size-4" /> {t(isTouch ? "camera.native" : "camera.pick")}
              </SheetAction>
              <SheetAction quiet onClick={onClose}>
                {t("common.close")}
              </SheetAction>
            </div>
          </div>
        ) : camera.stream ? null : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center text-white/75">
            <Spinner />
            <p className="max-w-xs text-[0.875rem] leading-relaxed">{t("camera.asking")}</p>
          </div>
        )}
      </div>
      <div className={cn("safe-bottom flex justify-center px-4 pt-3", camera.error && "invisible")}>
        <button
          type="button"
          aria-label={t("camera.shoot")}
          title={t("camera.shoot")}
          disabled={!camera.stream}
          onClick={() => void shoot()}
          className="flex size-[72px] items-center justify-center rounded-full border-4 border-white transition active:scale-95 disabled:opacity-40"
        >
          <span className="size-[54px] rounded-full bg-white" />
        </button>
      </div>
    </MediaSheet>
  );
}
