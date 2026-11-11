import { format, formatDistanceToNowStrict } from "date-fns";

export const fmtDate = (iso: string | null | undefined) => (iso ? format(new Date(iso), "d MMM yyyy, HH:mm") : "—");
export const fmtAgo = (iso: string) => `${formatDistanceToNowStrict(new Date(iso))} ago`;
export const fmtNumber = (n: number) => new Intl.NumberFormat("en-US").format(n);
export const shortUrl = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "");
