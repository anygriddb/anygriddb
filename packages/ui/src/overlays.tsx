/**
 * Dialogs, popovers, menus, and tooltips on React Aria Components
 * (ADR 0012): focus is trapped and restored, Escape and outside clicks
 * close, menus are keyboard-navigable with type-ahead, and every overlay
 * is announced by its role and label.
 */
import { useUiText } from "./text";
import { GripVertical, X } from "lucide-react";
import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  use,
  useId,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger,
  Focusable,
  Header,
  Heading,
  Menu,
  MenuItem,
  MenuSection,
  MenuTrigger,
  Modal,
  ModalOverlay,
  Popover as AriaPopover,
  Pressable,
  Separator,
  SubmenuTrigger,
  Tooltip as AriaTooltip,
  TooltipTrigger,
} from "react-aria-components";
import { cn } from "./cn";

const surface =
  "z-50 rounded-lg border border-border bg-card text-foreground shadow-lg outline-none";

const menuItem =
  "flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[disabled]:opacity-50 data-[focused]:bg-muted";

type Align = "start" | "center" | "end";

function placement(align: Align) {
  return align === "end"
    ? ("bottom end" as const)
    : align === "center"
      ? ("bottom" as const)
      : ("bottom start" as const);
}

/**
 * A trigger given as a child: a button, or a component that passes its
 * props and `ref` on to one (React 19 hands `ref` over like any prop).
 */
type TriggerChild = Parameters<typeof Pressable>[0]["children"];
type FocusableChild = Parameters<typeof Focusable>[0]["children"];

/** The text of a node, for menu type-ahead when an item holds an icon. */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node))
    return textOf(node.props.children);
  return "";
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

const DialogState = createContext<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
} | null>(null);

/** A modal dialog, open while `open` is true. */
export function Dialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <DialogState value={{ open: props.open, onOpenChange: props.onOpenChange }}>
      {props.children}
    </DialogState>
  );
}

/** The dialog's frame. Its content mounts on open and unmounts on close. */
export function DialogContent({
  className,
  children,
  title,
  description,
  wide,
}: {
  className?: string;
  children?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  wide?: boolean;
}) {
  const state = use(DialogState);
  const text = useUiText();
  const descriptionId = useId();
  if (!state) throw new Error("DialogContent must be inside a Dialog");
  return (
    <ModalOverlay
      isOpen={state.open}
      onOpenChange={state.onOpenChange}
      isDismissable
      className="fixed inset-0 z-40 bg-black/40"
    >
      <Modal
        className={cn(
          surface,
          "fixed top-[8vh] left-1/2 flex max-h-[84vh] w-[calc(100vw-2rem)] -translate-x-1/2 flex-col",
          wide ? "max-w-3xl" : "max-w-lg",
          className,
        )}
      >
        <AriaDialog
          className="flex min-h-0 flex-1 flex-col outline-none"
          aria-describedby={description ? descriptionId : undefined}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="flex flex-col gap-1">
              <Heading slot="title" className="text-base font-semibold">
                {title}
              </Heading>
              {description ? (
                <p id={descriptionId} className="text-sm text-muted-foreground">
                  {description}
                </p>
              ) : null}
            </div>
            <AriaButton
              slot="close"
              className="rounded p-1 text-muted-foreground outline-none hover:bg-muted data-[focus-visible]:outline-2 data-[focus-visible]:outline-ring"
              aria-label={text.close}
            >
              <X className="h-4 w-4" aria-hidden />
            </AriaButton>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}

export function DialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div className={cn("mt-5 flex justify-end gap-2", className)} {...props} />
  );
}

/* ------------------------------------------------------------------ */
/* Popover                                                             */
/* ------------------------------------------------------------------ */

/** A non-modal dialog next to its trigger. */
export function Popover(props: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <DialogTrigger isOpen={props.open} onOpenChange={props.onOpenChange}>
      {props.children}
    </DialogTrigger>
  );
}

/** The element that opens the popover: a button, given as the child. */
export function PopoverTrigger({
  children,
}: {
  /** Kept for readability at call sites: the child is always the trigger. */
  asChild?: true;
  children: ReactElement;
}) {
  return <Pressable>{children as TriggerChild}</Pressable>;
}

export function PopoverContent({
  className,
  align = "start",
  children,
  "aria-label": label,
}: {
  className?: string;
  align?: Align;
  children?: ReactNode;
  "aria-label"?: string;
}) {
  return (
    <AriaPopover
      placement={placement(align)}
      offset={4}
      className={cn(surface, "max-h-[70vh] overflow-y-auto p-3", className)}
    >
      <AriaDialog className="outline-none" aria-label={label}>
        {children}
      </AriaDialog>
    </AriaPopover>
  );
}

/* ------------------------------------------------------------------ */
/* Menus                                                               */
/* ------------------------------------------------------------------ */

export function DropdownMenu(props: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <MenuTrigger isOpen={props.open} onOpenChange={props.onOpenChange}>
      {props.children}
    </MenuTrigger>
  );
}

/**
 * The button that opens a menu. With `asChild`, the child is that button;
 * otherwise this renders one with the given class and label.
 */
export function DropdownMenuTrigger({
  asChild,
  className,
  style,
  children,
  "aria-label": label,
}: {
  asChild?: boolean;
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
  "aria-label"?: string;
}) {
  if (asChild && isValidElement(children)) {
    return <Pressable>{children as TriggerChild}</Pressable>;
  }
  return (
    <AriaButton
      className={cn(
        "outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-ring",
        className,
      )}
      style={style}
      aria-label={label}
    >
      {children}
    </AriaButton>
  );
}

export function DropdownMenuContent({
  className,
  align = "start",
  children,
}: {
  className?: string;
  align?: Align;
  children: ReactNode;
}) {
  return (
    <AriaPopover
      placement={placement(align)}
      offset={4}
      className={cn(surface, "min-w-48 overflow-y-auto p-1", className)}
    >
      <Menu className="max-h-[70vh] outline-none">{children}</Menu>
    </AriaPopover>
  );
}

export function DropdownMenuItem({
  className,
  danger,
  disabled,
  onSelect,
  textValue,
  children,
}: {
  className?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  /** What type-ahead matches; the item's text by default. */
  textValue?: string;
  children: ReactNode;
}) {
  return (
    <MenuItem
      onAction={onSelect}
      isDisabled={disabled}
      textValue={textValue ?? textOf(children)}
      className={cn(menuItem, danger && "text-danger", className)}
    >
      {children}
    </MenuItem>
  );
}

export function DropdownMenuSeparator() {
  return <Separator className="my-1 h-px bg-border" />;
}

/** Items under a heading, such as "Shared views". */
export function DropdownMenuSection({
  title,
  children,
}: {
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <MenuSection>
      <Header className="truncate px-2 py-1 text-xs font-medium text-muted-foreground">
        {title}
      </Header>
      {children}
    </MenuSection>
  );
}

/** An item that opens a nested menu: its trigger, then its content. */
export function DropdownMenuSub({ children }: { children: ReactNode }) {
  const [trigger, content] = Children.toArray(children);
  if (!isValidElement(trigger) || !isValidElement(content)) {
    throw new Error("DropdownMenuSub takes a trigger and a content");
  }
  return (
    <SubmenuTrigger>
      {trigger}
      {content}
    </SubmenuTrigger>
  );
}

export function DropdownMenuSubTrigger({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <MenuItem textValue={textOf(children)} className={cn(menuItem, className)}>
      {children}
    </MenuItem>
  );
}

export function DropdownMenuSubContent({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <AriaPopover offset={-4} className={cn(surface, "min-w-44 p-1", className)}>
      <Menu className="outline-none">{children}</Menu>
    </AriaPopover>
  );
}

/* ------------------------------------------------------------------ */
/* Context menu                                                        */
/* ------------------------------------------------------------------ */

const ContextMenuState = createContext<{
  point: { x: number; y: number } | null;
  openAt: (point: { x: number; y: number }) => void;
  close: () => void;
  anchor: React.RefObject<HTMLSpanElement | null>;
} | null>(null);

function useContextMenu() {
  const state = use(ContextMenuState);
  if (!state) throw new Error("Context menu parts must be inside ContextMenu");
  return state;
}

/**
 * A menu opened at the pointer by a right click, or at the focused
 * element by the context-menu key or Shift+F10.
 */
export function ContextMenu({ children }: { children: ReactNode }) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  return (
    <ContextMenuState
      value={{
        point,
        openAt: setPoint,
        close: () => setPoint(null),
        anchor,
      }}
    >
      {children}
      <span
        ref={anchor}
        aria-hidden
        className="pointer-events-none fixed h-0 w-0"
        style={{ left: point?.x ?? 0, top: point?.y ?? 0 }}
      />
    </ContextMenuState>
  );
}

export function ContextMenuTrigger({
  children,
}: {
  asChild?: true;
  children: ReactElement<{
    onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void;
  }>;
}) {
  const { openAt } = useContextMenu();
  const own = children.props.onContextMenu;
  return cloneElement(children, {
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
      own?.(event);
      if (event.defaultPrevented) return;
      event.preventDefault();
      // From the keyboard, the event has no pointer position.
      if (event.clientX === 0 && event.clientY === 0) {
        const box = (event.target as HTMLElement).getBoundingClientRect();
        openAt({ x: box.left, y: box.bottom });
      } else {
        openAt({ x: event.clientX, y: event.clientY });
      }
    },
  });
}

export function ContextMenuContent({
  className,
  children,
  "aria-label": label = "Actions",
}: {
  className?: string;
  children: ReactNode;
  "aria-label"?: string;
}) {
  const { point, close, anchor } = useContextMenu();
  return (
    <AriaPopover
      triggerRef={anchor}
      isOpen={point !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      placement="bottom start"
      className={cn(surface, "min-w-48 p-1", className)}
    >
      <Menu
        aria-label={label}
        onClose={close}
        className="outline-none"
        autoFocus="first"
      >
        {children}
      </Menu>
    </AriaPopover>
  );
}

export const ContextMenuItem = DropdownMenuItem;
export const ContextMenuSeparator = DropdownMenuSeparator;

/* ------------------------------------------------------------------ */
/* Tooltip                                                             */
/* ------------------------------------------------------------------ */

/**
 * A label shown on hover and on keyboard focus. The child must be
 * focusable and have a role: a button, a link, or an image with a label.
 */
export function Tooltip({
  content,
  children,
  side = "top",
}: {
  content: ReactNode;
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <TooltipTrigger delay={300}>
      <Focusable>{children as FocusableChild}</Focusable>
      <AriaTooltip
        placement={side}
        offset={6}
        className="z-50 max-w-xs rounded bg-foreground px-2 py-1 text-xs text-background"
      >
        {content}
      </AriaTooltip>
    </TooltipTrigger>
  );
}

/* ------------------------------------------------------------------ */
/* Drag handle                                                         */
/* ------------------------------------------------------------------ */

/**
 * The keyboard and screen-reader way to drag an item that has other
 * interactions: Enter picks it up, Tab moves between drop targets, Enter
 * drops. Takes the `dragButtonProps` of `useDrag`.
 */
export function DragHandle({
  label,
  className,
  ...buttonProps
}: Omit<React.ComponentProps<typeof AriaButton>, "className" | "children"> & {
  label: string;
  className?: string;
}) {
  return (
    <AriaButton
      {...buttonProps}
      aria-label={label}
      className={cn(
        "rounded p-0.5 text-muted-foreground outline-none hover:bg-muted data-[focus-visible]:outline-2 data-[focus-visible]:outline-ring",
        className,
      )}
    >
      <GripVertical className="h-3.5 w-3.5" aria-hidden />
    </AriaButton>
  );
}
