import { useEffect, useRef, useState } from "react";

export function useBlobUrl() {
  const urlRef = useRef<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  const update = (newUrl: string | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = newUrl;
    setUrl(newUrl);
  };

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  return [url, update] as const;
}
