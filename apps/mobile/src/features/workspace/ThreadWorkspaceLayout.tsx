import { HeaderHeightContext } from "@react-navigation/elements";
import {
  NavigationContext,
  NavigationRouteContext,
  useFocusEffect,
} from "@react-navigation/native";
import { createContext, use, useCallback, useMemo, useState, type ReactNode } from "react";
import { useWindowDimensions, View } from "react-native";

import {
  deriveLayout,
  deriveThreadWorkspaceInspectorPaneLayout,
  type ThreadWorkspaceInspectorPaneLayout,
} from "../../lib/layout";
import {
  releaseOwnedThreadWorkspaceInspector,
  type OwnedThreadWorkspaceInspector,
  type ThreadWorkspaceInspectorKind,
} from "./threadWorkspaceInspectorState";

interface ThreadWorkspaceInspectorPresentation {
  readonly accessibilityLabel: string;
  readonly render: () => ReactNode;
}

interface ThreadWorkspaceContextValue {
  readonly inspector: ThreadWorkspaceInspectorPaneLayout;
  readonly activeInspectorKind: ThreadWorkspaceInspectorKind | null;
  readonly registerInspector: (
    kind: ThreadWorkspaceInspectorKind,
    presentation: ThreadWorkspaceInspectorPresentation,
  ) => () => void;
}

const compactLayout = deriveLayout({ width: 0, height: 0 });
const compactInspector = deriveThreadWorkspaceInspectorPaneLayout({
  layout: compactLayout,
  viewportWidth: 0,
});
const ThreadWorkspaceContext = createContext<ThreadWorkspaceContextValue>({
  inspector: compactInspector,
  activeInspectorKind: null,
  registerInspector: () => () => undefined,
});

export function useThreadWorkspaceLayout(): ThreadWorkspaceContextValue {
  return use(ThreadWorkspaceContext);
}

/**
 * Hand the focused native route's workspace tool to the root inspector column.
 *
 * The pane is a sibling of the native navigator so the route keeps its own
 * correctly sized native header. Navigation and header contexts are captured
 * here and restored around the pane because React contexts belong to where a
 * render function is invoked, not where it was created.
 */
export function useRegisterThreadWorkspaceInspector(
  kind: ThreadWorkspaceInspectorKind,
  render: (() => ReactNode) | undefined,
  accessibilityLabel: string,
) {
  const { registerInspector } = useThreadWorkspaceLayout();
  const navigation = use(NavigationContext);
  const route = use(NavigationRouteContext);
  const headerHeight = use(HeaderHeightContext);
  const presentation = useMemo<ThreadWorkspaceInspectorPresentation | undefined>(() => {
    if (render === undefined) return undefined;
    return {
      accessibilityLabel,
      render: () => (
        <NavigationContext.Provider value={navigation}>
          <NavigationRouteContext.Provider value={route}>
            <HeaderHeightContext.Provider value={headerHeight}>
              {render()}
            </HeaderHeightContext.Provider>
          </NavigationRouteContext.Provider>
        </NavigationContext.Provider>
      ),
    };
  }, [accessibilityLabel, headerHeight, navigation, render, route]);

  // Focus owns the registration. Native screens can freeze after blur, but
  // navigation still delivers focus cleanup, so a sheet or another route can
  // never inherit a stale workspace tool.
  useFocusEffect(
    useCallback(() => {
      if (presentation === undefined) return undefined;
      return registerInspector(kind, presentation);
    }, [kind, presentation, registerInspector]),
  );
}

/**
 * Responsive host for the regular-width workspace inspector.
 *
 * It deliberately owns presentation only. A registered tool keeps using the
 * same RPC queries and shared thread/workspace state as its phone route, so
 * resizing cannot create a second runtime boundary. Below the inspector
 * breakpoint nothing registers and the column never renders.
 */
export function ThreadWorkspaceLayout(props: { readonly children: ReactNode }) {
  const { width, height } = useWindowDimensions();
  const layout = useMemo(() => deriveLayout({ width, height }), [height, width]);
  const inspector = useMemo(
    () => deriveThreadWorkspaceInspectorPaneLayout({ layout, viewportWidth: width }),
    [layout, width],
  );
  const [registration, setRegistration] =
    useState<OwnedThreadWorkspaceInspector<ThreadWorkspaceInspectorPresentation> | null>(null);

  const registerInspector = useCallback(
    (kind: ThreadWorkspaceInspectorKind, presentation: ThreadWorkspaceInspectorPresentation) => {
      const owner = Symbol(`thread-workspace-${kind}`);
      setRegistration({ owner, kind, value: presentation });
      return () => {
        setRegistration((current) => releaseOwnedThreadWorkspaceInspector(current, owner));
      };
    },
    [],
  );
  const activeInspectorKind = registration?.kind ?? null;
  const contextValue = useMemo(
    () => ({ inspector, activeInspectorKind, registerInspector }),
    [activeInspectorKind, inspector, registerInspector],
  );
  const inspectorVisible = inspector.supported && inspector.width !== null && registration !== null;

  return (
    <ThreadWorkspaceContext.Provider value={contextValue}>
      <View testID="thread-workspace-layout" className="flex-1 flex-row bg-screen">
        <View className="min-w-0 flex-1">{props.children}</View>
        {inspectorVisible ? (
          <View
            accessibilityLabel={registration.value.accessibilityLabel}
            className="shrink-0 border-l border-border bg-screen"
            style={{ width: inspector.width ?? 0 }}
          >
            {registration.value.render()}
          </View>
        ) : null}
      </View>
    </ThreadWorkspaceContext.Provider>
  );
}
