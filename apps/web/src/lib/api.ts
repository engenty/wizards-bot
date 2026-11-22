// From engenty wizards, packages/runner/src/api.ts: the client's shape. The home takes a device
// token where wizards takes a cookie.
import { t } from "./i18n";
import { deviceToken, setDeviceToken } from "./session";

/** A call the home refused, or one that never reached it (`status` 0). */
export class ApiError extends Error {
  readonly status: number;
  /** The home's body: `error` is its code, and a 409 carries the card or document it kept. */
  readonly body: { error?: string; [key: string]: unknown } | null;

  constructor(message: string, status: number, body: ApiError["body"]) {
    super(message);
    this.status = status;
    this.body = body;
  }

  /** The home's code for what went wrong, e.g. `already_answered`. */
  get code(): string | undefined {
    return this.body?.error;
  }
}

/** A body as JSON; one that is not (a proxy's error page) as nothing. */
function safeJson(text: string): ApiError["body"] {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface Api {
  /** `signal`: a call that is no longer wanted ends. */
  get<T>(path: string, signal?: AbortSignal): Promise<T>;
  post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  del(path: string): Promise<void>;
  upload<T>(path: string, file: File, signal?: AbortSignal): Promise<T>;
  /** The answer itself, for what is no JSON: the event stream, a file's bytes. */
  open(
    path: string,
    init?: { headers?: Record<string, string>; signal?: AbortSignal },
  ): Promise<Response>;
}

/**
 * Calls to the home with this device's token. A refused call throws an `ApiError` with the
 * home's sentence for the person. `onUnpaired`: the home no longer knows the token.
 */
function createApi(token: () => string | null, onUnpaired: () => void): Api {
  async function open(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: BodyInit;
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> {
    const sent = token();
    const res = await fetch(path, {
      ...init,
      headers: { ...(sent ? { authorization: `Bearer ${sent}` } : {}), ...init.headers },
    }).catch((err: unknown) => {
      if (init.signal?.aborted) {
        throw err;
      }
      throw new ApiError(t("home.away"), 0, null);
    });
    if (res.ok) {
      return res;
    }
    if (res.status === 401 && sent) {
      onUnpaired();
    }
    const data = safeJson(await res.text());
    const said = typeof data?.message === "string" ? data.message : null;
    throw new ApiError(said ?? t("home.refused", { status: res.status }), res.status, data);
  }
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const form = body instanceof FormData;
    const res = await open(path, {
      method,
      signal,
      headers: body === undefined || form ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  return {
    get: (path, signal) => request("GET", path, undefined, signal),
    post: (path, body, signal) => request("POST", path, body, signal),
    put: (path, body) => request("PUT", path, body),
    patch: (path, body) => request("PATCH", path, body),
    del: (path) => request("DELETE", path),
    upload: (path, file, signal) => {
      const form = new FormData();
      form.set("file", file);
      return request("POST", path, form, signal);
    },
    open,
  };
}

/** The home this page came from, with this browser's device token. */
export const api = createApi(deviceToken, () => setDeviceToken(null));
