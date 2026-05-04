import { Parser } from "../../types";
import { parseUniversal } from "./universal";

export function detectParser(): Parser {
  return parseUniversal;
}
