import {
  cloneElement,
  isValidElement,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "./cn";

/**
 * Renders its only child with these props merged in: the child's own
 * props win, class names add up. For a link styled as a button.
 */
export function Slot({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLElement> & { children?: ReactNode }) {
  if (!isValidElement<HTMLAttributes<HTMLElement>>(children)) return null;
  return cloneElement(children, {
    ...props,
    ...children.props,
    className: cn(className, children.props.className),
  });
}
