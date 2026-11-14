import { PRODUCT_NAME } from "@anygriddb/core";
import { cn } from "@anygriddb/ui";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "../../lib/trpc";
import { BrandMark } from "./brand-mark";

/** Where a page loads the instance's logo from: its version in the address. */
export function instanceLogoUrl(version: string): string {
  return `/api/instance/logo?v=${encodeURIComponent(version)}`;
}

/**
 * What the instance calls itself and the logo it shows (ADR 0072): the
 * product's name and no logo until an administrator sets them.
 */
export function useInstanceIdentity(): { name: string; logo: string | null } {
  const api = useTRPC();
  const instance = useQuery(api.auth.instance.queryOptions());
  return {
    name: instance.data?.instanceName ?? PRODUCT_NAME,
    logo: instance.data?.logo ?? null,
  };
}

/** The instance's name, as text. */
export function InstanceName() {
  return useInstanceIdentity().name;
}

/**
 * The instance's mark, wherever the product's would be: its logo in the
 * mark's square, or the product's mark until it has one.
 */
export function InstanceMark({
  className,
  named = false,
}: {
  className?: string;
  /** Names the mark for assistive technology: where no name stands beside it. */
  named?: boolean;
}) {
  const { name, logo } = useInstanceIdentity();
  if (!logo) {
    return <BrandMark className={className} title={named ? name : undefined} />;
  }
  return (
    <img
      src={instanceLogoUrl(logo)}
      alt={named ? name : ""}
      className={cn("shrink-0 object-contain", className)}
    />
  );
}
