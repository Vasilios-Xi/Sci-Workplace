import { useLayoutEffect, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';

export type FloatingPlacement = 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';

interface FloatingPositionOptions {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  surfaceRef: RefObject<HTMLElement | null>;
  placement?: FloatingPlacement;
  offset?: number;
  viewportMargin?: number;
}

export function useFloatingPosition({
  open,
  anchorRef,
  surfaceRef,
  placement = 'top-end',
  offset = 8,
  viewportMargin = 8,
}: FloatingPositionOptions): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', left: viewportMargin, top: viewportMargin, visibility: 'hidden' });

  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const anchor = anchorRef.current;
        const surface = surfaceRef.current;
        if (!anchor || !surface) return;
        const anchorBox = anchor.getBoundingClientRect();
        const surfaceBox = surface.getBoundingClientRect();
        const preferTop = placement.startsWith('top');
        const roomAbove = anchorBox.top - viewportMargin;
        const roomBelow = window.innerHeight - anchorBox.bottom - viewportMargin;
        const placeAbove = preferTop ? roomAbove >= surfaceBox.height + offset || roomAbove >= roomBelow : !(roomBelow >= surfaceBox.height + offset || roomBelow >= roomAbove);
        const alignedEnd = placement.endsWith('end');
        const idealLeft = alignedEnd ? anchorBox.right - surfaceBox.width : anchorBox.left;
        const left = Math.min(
          Math.max(viewportMargin, idealLeft),
          Math.max(viewportMargin, window.innerWidth - surfaceBox.width - viewportMargin),
        );
        const idealTop = placeAbove ? anchorBox.top - surfaceBox.height - offset : anchorBox.bottom + offset;
        const top = Math.min(
          Math.max(viewportMargin, idealTop),
          Math.max(viewportMargin, window.innerHeight - surfaceBox.height - viewportMargin),
        );
        setStyle({ position: 'fixed', left, top, visibility: 'visible' });
      });
    };
    update();
    window.addEventListener('resize', update);
    document.addEventListener('scroll', update, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
      document.removeEventListener('scroll', update, true);
    };
  }, [anchorRef, offset, open, placement, surfaceRef, viewportMargin]);

  return style;
}
