import { HttpMethod } from "../../api";

/** The methods the HTTP client offers, in the order its select lists them. */
export const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** Methods the tool doesn't send a body for -- mirrored from the tool's own UI. */
export const BODYLESS_METHODS: HttpMethod[] = ["GET", "HEAD"];
