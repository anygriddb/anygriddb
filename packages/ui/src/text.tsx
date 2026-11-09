import { createContext, use, useMemo, type ReactNode } from "react";

/**
 * The few words the components say themselves, such as a dialog's close
 * button. The app passes them in its people's language; English is only
 * the fallback of a component used outside it.
 */
export type UiText = { close: string; loading: string };

const UiTextContext = createContext<UiText>({
  close: "Close",
  loading: "Loading",
});

export function UiTextProvider(props: UiText & { children: ReactNode }) {
  const { close, loading } = props;
  const value = useMemo(() => ({ close, loading }), [close, loading]);
  return <UiTextContext value={value}>{props.children}</UiTextContext>;
}

export function useUiText(): UiText {
  return use(UiTextContext);
}
