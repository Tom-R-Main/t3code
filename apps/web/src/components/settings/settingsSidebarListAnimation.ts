import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

const SETTINGS_MENU_ITEM_SELECTOR = ":scope > [data-settings-menu-key]";
const SETTINGS_MENU_ANIMATION_DURATION_MS = 150;
const SETTINGS_MENU_ANIMATION_EASING = "cubic-bezier(0.16, 1, 0.3, 1)";

type ItemSnapshot = {
  readonly element: HTMLElement;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

type ListSnapshot = {
  readonly height: number;
  readonly items: ReadonlyMap<string, ItemSnapshot>;
};

function captureListSnapshot(list: HTMLUListElement): ListSnapshot {
  const listRect = list.getBoundingClientRect();
  const viewportRect =
    list.closest<HTMLElement>('[data-sidebar="content"]')?.getBoundingClientRect() ?? listRect;
  const items = new Map<string, ItemSnapshot>();

  for (const element of list.querySelectorAll<HTMLElement>(SETTINGS_MENU_ITEM_SELECTOR)) {
    const key = element.dataset.settingsMenuKey;
    if (!key) continue;
    const rect = element.getBoundingClientRect();
    if (rect.bottom < viewportRect.top || rect.top > viewportRect.bottom) continue;
    items.set(key, {
      element,
      left: rect.left - listRect.left,
      top: rect.top - listRect.top,
      width: rect.width,
      height: rect.height,
    });
  }

  return { height: listRect.height, items };
}

function disableGhostContent(element: HTMLElement) {
  element.removeAttribute("id");
  for (const descendant of element.querySelectorAll<HTMLElement>("[id]")) {
    descendant.removeAttribute("id");
  }
  for (const descendant of element.querySelectorAll<HTMLElement>("*")) {
    descendant.tabIndex = -1;
  }
}

function createGhostLayer(
  list: HTMLUListElement,
  previousSnapshot: ListSnapshot,
  nextSnapshot: ListSnapshot,
) {
  const removedItems = [...previousSnapshot.items].filter(([key]) => !nextSnapshot.items.has(key));
  if (removedItems.length === 0) return null;

  const layer = document.createElement("li");
  layer.setAttribute("aria-hidden", "true");
  if (list.getAttribute("role") === "listbox") {
    layer.setAttribute("role", "presentation");
  }
  layer.inert = true;
  Object.assign(layer.style, {
    height: `${previousSnapshot.height}px`,
    left: "0",
    pointerEvents: "none",
    position: "absolute",
    top: "0",
    width: "100%",
    zIndex: "1",
  });

  for (const [, snapshot] of removedItems) {
    const ghost = document.createElement("div");
    ghost.className = snapshot.element.className;
    for (const child of snapshot.element.childNodes) {
      ghost.append(child.cloneNode(true));
    }
    disableGhostContent(ghost);
    Object.assign(ghost.style, {
      height: `${snapshot.height}px`,
      left: `${snapshot.left}px`,
      position: "absolute",
      top: `${snapshot.top}px`,
      width: `${snapshot.width}px`,
    });
    layer.append(ghost);
  }

  list.append(layer);
  return layer;
}

export function useSettingsSidebarListAnimation(
  listRef: RefObject<HTMLUListElement | null>,
  itemOrderKey: string,
) {
  const itemOrderKeyRef = useRef<string | null>(null);
  const snapshotRef = useRef<ListSnapshot | null>(null);
  const preparedSnapshotRef = useRef<ListSnapshot | null>(null);
  const animationsRef = useRef(new Set<Animation>());
  const ghostLayerRef = useRef<HTMLLIElement | null>(null);
  const heightAnimationRef = useRef<Animation | null>(null);

  const stopAnimations = useCallback(() => {
    const list = listRef.current;
    for (const animation of animationsRef.current) {
      animation.cancel();
    }
    animationsRef.current.clear();
    ghostLayerRef.current?.remove();
    ghostLayerRef.current = null;
    heightAnimationRef.current = null;
    list?.style.removeProperty("height");
    list?.style.removeProperty("overflow");
  }, [listRef]);

  const trackAnimation = useCallback((animation: Animation, onFinish?: () => void) => {
    animationsRef.current.add(animation);
    void animation.finished.then(
      () => {
        if (!animationsRef.current.delete(animation)) return;
        onFinish?.();
      },
      () => {
        animationsRef.current.delete(animation);
      },
    );
  }, []);

  const prepareAnimation = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    preparedSnapshotRef.current = captureListSnapshot(list);
  }, [listRef]);

  useLayoutEffect(() => {
    if (itemOrderKeyRef.current === itemOrderKey) return;
    itemOrderKeyRef.current = itemOrderKey;
    const list = listRef.current;
    if (!list) return;

    const previousSnapshot = preparedSnapshotRef.current ?? snapshotRef.current;
    preparedSnapshotRef.current = null;
    stopAnimations();
    const nextSnapshot = captureListSnapshot(list);
    snapshotRef.current = nextSnapshot;

    const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!previousSnapshot || prefersReducedMotion || typeof list.animate !== "function") return;

    if (Math.abs(previousSnapshot.height - nextSnapshot.height) >= 0.5) {
      list.style.height = `${previousSnapshot.height}px`;
      list.style.overflow = "hidden";
      const heightAnimation = list.animate(
        [{ height: `${previousSnapshot.height}px` }, { height: `${nextSnapshot.height}px` }],
        {
          duration: SETTINGS_MENU_ANIMATION_DURATION_MS,
          easing: SETTINGS_MENU_ANIMATION_EASING,
        },
      );
      heightAnimationRef.current = heightAnimation;
      trackAnimation(heightAnimation, () => {
        if (heightAnimationRef.current !== heightAnimation) return;
        heightAnimationRef.current = null;
        list.style.removeProperty("height");
        list.style.removeProperty("overflow");
      });
    }

    for (const [key, nextItem] of nextSnapshot.items) {
      const previousItem = previousSnapshot.items.get(key);
      if (!previousItem) continue;
      const translateX = previousItem.left - nextItem.left;
      const translateY = previousItem.top - nextItem.top;
      if (Math.abs(translateX) < 0.5 && Math.abs(translateY) < 0.5) continue;

      const element = nextItem.element;
      if (!element || typeof element.animate !== "function") continue;
      trackAnimation(
        element.animate(
          [
            { transform: `translate3d(${translateX}px, ${translateY}px, 0)` },
            { transform: "translate3d(0, 0, 0)" },
          ],
          {
            duration: SETTINGS_MENU_ANIMATION_DURATION_MS,
            easing: SETTINGS_MENU_ANIMATION_EASING,
          },
        ),
      );
    }

    const ghostLayer = createGhostLayer(list, previousSnapshot, nextSnapshot);
    if (!ghostLayer || typeof ghostLayer.animate !== "function") return;
    ghostLayerRef.current = ghostLayer;
    const ghostAnimation = ghostLayer.animate(
      [
        { opacity: 1, transform: "translate3d(0, 0, 0)" },
        { opacity: 0, transform: "translate3d(0, -4px, 0)" },
      ],
      {
        duration: SETTINGS_MENU_ANIMATION_DURATION_MS,
        easing: SETTINGS_MENU_ANIMATION_EASING,
      },
    );
    trackAnimation(ghostAnimation, () => {
      if (ghostLayerRef.current !== ghostLayer) return;
      ghostLayerRef.current = null;
      ghostLayer.remove();
    });
  }, [itemOrderKey, listRef, stopAnimations, trackAnimation]);

  useLayoutEffect(() => stopAnimations, [stopAnimations]);

  return prepareAnimation;
}
