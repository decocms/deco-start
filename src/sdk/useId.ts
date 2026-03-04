import { useId as useReactId } from "react";

/** Wraps React's useId, stripping colons for safe DOM usage */
export const useId = () => {
  const id = useReactId();
  return id.replace(/:/g, "");
};
