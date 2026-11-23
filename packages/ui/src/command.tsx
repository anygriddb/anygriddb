import { Command as CommandPrimitive, useCommandState } from "cmdk";
import type { ComponentProps } from "react";
import { cn } from "./cn";

export function Command({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn("flex flex-col overflow-hidden", className)}
      {...props}
    />
  );
}

export function CommandInput({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <CommandPrimitive.Input
      className={cn(
        "h-10 w-full border-b border-border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** The options. With none left it is hidden: a listbox holds options. */
export function CommandList({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.List>) {
  const empty = useCommandState((state) => state.filtered.count === 0);
  return (
    <CommandPrimitive.List
      hidden={empty}
      className={cn("max-h-80 overflow-y-auto p-1", className)}
      {...props}
    />
  );
}

/**
 * What a search that found nothing says. It goes beside `CommandList`, not
 * in it, and its region is there before the message so that it is announced.
 */
export function CommandEmpty(
  props: ComponentProps<typeof CommandPrimitive.Empty>,
) {
  return (
    <div role="status">
      <CommandPrimitive.Empty
        className="px-3 py-6 text-center text-sm text-muted-foreground"
        {...props}
      />
    </div>
  );
}

export function CommandGroup({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function CommandItem({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        "flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-sm data-[selected=true]:bg-muted",
        className,
      )}
      {...props}
    />
  );
}
