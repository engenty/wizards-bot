/**
 * The Mac app shows this web app in a web view and adds what only the Mac can do: its
 * notifications, the number on its Dock icon and, when the Bot Server runs on the same Mac,
 * its folder dialog. Outside the app every function here does nothing.
 */

interface MacHandler {
  postMessage(message: unknown): Promise<unknown>;
}

declare global {
  interface Window {
    wizardsMac?: { local: boolean; name: string };
    webkit?: { messageHandlers?: { wizardsMac?: MacHandler } };
  }
}

const handler = (): MacHandler | undefined => window.webkit?.messageHandlers?.wizardsMac;

/** The page runs in the Mac app. */
export const inMacApp = (): boolean => Boolean(window.wizardsMac && handler());

/** The Mac's name, for the device the app pairs as. */
export const macName = (): string | undefined => (inMacApp() ? window.wizardsMac?.name : undefined);

/** Hands something to the Mac app; nothing when the page is not in it. */
export async function toMac<T>(
  message: { type: string } & Record<string, unknown>,
): Promise<T | undefined> {
  const mac = handler();
  if (!mac) {
    return undefined;
  }
  try {
    return (await mac.postMessage(message)) as T;
  } catch {
    return undefined;
  }
}

/**
 * The Mac's folder dialog, when the Bot Server runs on this Mac: the chosen path, null when the
 * person closed it, undefined when there is no such dialog here.
 */
export async function pickFolderOnMac(): Promise<string | null | undefined> {
  if (!(inMacApp() && window.wizardsMac?.local)) {
    return undefined;
  }
  const path = await toMac<string | null>({ type: "pickFolder" });
  return path ?? null;
}
