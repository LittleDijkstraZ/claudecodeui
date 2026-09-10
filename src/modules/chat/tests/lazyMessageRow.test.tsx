import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { useRef } from 'react';
import { act, render } from '@testing-library/react';

import { useLazyRowObserver } from '@/modules/chat/hooks/useLazyRowObserver';
import LazyMessageRow from '@/modules/chat/transcript/LazyMessageRow';

/**
 * Drivable IntersectionObserver stand-in: jsdom has none, so these tests
 * install one and fire its callback by hand to walk a row through the
 * near-viewport / far-away transitions.
 */
class StubIntersectionObserver {
  static instances: StubIntersectionObserver[] = [];

  callback: IntersectionObserverCallback;
  observed: Element[] = [];

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    StubIntersectionObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observed.push(element);
  }

  unobserve(element: Element): void {
    this.observed = this.observed.filter((observed) => observed !== element);
  }

  disconnect(): void {
    this.observed = [];
  }
}

function fireIntersection(
  observer: StubIntersectionObserver,
  target: Element,
  isIntersecting: boolean,
  rect: { width: number; height: number } = { width: 100, height: 40 },
): void {
  act(() => {
    observer.callback(
      [{ target, isIntersecting, boundingClientRect: rect } as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    );
  });
}

function Harness({ initiallyNearViewport }: { initiallyNearViewport: boolean }) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const lazyRows = useLazyRowObserver(scrollContainerRef);
  return (
    <div ref={scrollContainerRef}>
      <LazyMessageRow
        lazyRows={lazyRows}
        timestamp="2026-01-01T00:00:00.000Z"
        initiallyNearViewport={initiallyNearViewport}
      >
        <span data-testid="row-content">expensive content</span>
      </LazyMessageRow>
    </div>
  );
}

afterEach(() => {
  StubIntersectionObserver.instances = [];
  vi.unstubAllGlobals();
});

describe('LazyMessageRow', () => {
  it('starts far rows as an addressable placeholder instead of mounting content', () => {
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);

    const { container, queryByTestId } = render(<Harness initiallyNearViewport={false} />);

    expect(queryByTestId('row-content')).toBeNull();
    const wrapper = container.querySelector('[data-message-timestamp="2026-01-01T00:00:00.000Z"]');
    expect(wrapper).not.toBeNull();
    expect((wrapper as HTMLElement).style.height).not.toBe('');
  });

  it('unmounts to a placeholder of the measured height and remounts when near again', () => {
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);

    const { queryByTestId } = render(<Harness initiallyNearViewport />);
    expect(queryByTestId('row-content')).not.toBeNull();

    const observer = StubIntersectionObserver.instances[0];
    const wrapper = observer.observed[0] as HTMLElement;
    Object.defineProperty(wrapper, 'offsetHeight', { value: 123, configurable: true });

    fireIntersection(observer, wrapper, false);
    expect(queryByTestId('row-content')).toBeNull();
    expect(wrapper.style.height).toBe('123px');

    fireIntersection(observer, wrapper, true);
    expect(queryByTestId('row-content')).not.toBeNull();
    expect(wrapper.style.height).toBe('');
  });

  it('ignores the zero-rect non-intersections a hidden tab reports', () => {
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);

    const { queryByTestId } = render(<Harness initiallyNearViewport />);
    const observer = StubIntersectionObserver.instances[0];
    const wrapper = observer.observed[0] as HTMLElement;

    fireIntersection(observer, wrapper, false, { width: 0, height: 0 });

    expect(queryByTestId('row-content')).not.toBeNull();
  });

  it('keeps every row mounted where IntersectionObserver does not exist', () => {
    const { queryByTestId } = render(<Harness initiallyNearViewport={false} />);

    expect(queryByTestId('row-content')).not.toBeNull();
    expect(StubIntersectionObserver.instances).toHaveLength(0);
  });
});

function ScrollHarness({ onLayoutScroll }: { onLayoutScroll?: () => void }) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const lazyRows = useLazyRowObserver(scrollContainerRef, onLayoutScroll);
  return (
    <div ref={scrollContainerRef}>
      {[false, false, true, false].map((mounted, index) => (
        <LazyMessageRow key={index} lazyRows={lazyRows} timestamp={String(index)} initiallyNearViewport={mounted}>
          <span>row {index}</span>
        </LazyMessageRow>
      ))}
    </div>
  );
}

describe('lazy history scroll position', () => {
  it.each([false, true])('keeps the visible row fixed when estimates above it expand (native anchoring: %s)', nativeAnchoring => {
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);
    const reportedPositions: number[] = [];
    let viewport: HTMLDivElement;
    const onLayoutScroll = vi.fn(() => { reportedPositions.push(viewport.scrollTop); });
    const { container, rerender } = render(<ScrollHarness onLayoutScroll={onLayoutScroll} />);
    viewport = container.firstElementChild as HTMLDivElement;
    const observer = StubIntersectionObserver.instances[0];
    const rows = observer.observed as HTMLElement[];
    let scrollTop = 3200;
    let nativeAdjusted = false;
    Object.defineProperty(viewport, 'scrollTop', { get: () => scrollTop, set: value => { scrollTop = value; } });
    viewport.getBoundingClientRect = () => ({ top: 0, bottom: 500, height: 500 } as DOMRect);
    rows.forEach((row, index) => {
      row.getBoundingClientRect = () => {
        const expanded = rows[0].childElementCount > 0 && rows[1].childElementCount > 0;
        if (nativeAnchoring && expanded && !nativeAdjusted) { scrollTop += 1900; nativeAdjusted = true; }
        const height = row.childElementCount ? (index < 2 ? [1400, 700][index] : 500) : 100;
        const offset = 3000 + rows.slice(0, index).reduce((sum, previous, previousIndex) =>
          sum + (previous.childElementCount ? (previousIndex < 2 ? [1400, 700][previousIndex] : 500) : 100), 0);
        return { top: offset - scrollTop, bottom: offset - scrollTop + height, height, width: 100 } as DOMRect;
      };
    });
    act(() => {
      observer.callback(rows.slice(0, 2).map(target => ({
        target, isIntersecting: true, boundingClientRect: target.getBoundingClientRect(),
      } as unknown as IntersectionObserverEntry)), observer as unknown as IntersectionObserver);
    });
    expect(rows[2].getBoundingClientRect().top).toBe(0);
    expect(scrollTop).toBe(5100);
    expect(reportedPositions).toEqual([5100]);

    // Mounting a row below the reader must not move the viewport.
    const nextOwner = vi.fn(() => { reportedPositions.push(viewport.scrollTop); });
    rerender(<ScrollHarness onLayoutScroll={nextOwner} />);
    fireIntersection(observer, rows[3], true);
    expect(scrollTop).toBe(5100);
    expect(StubIntersectionObserver.instances).toHaveLength(1);
    expect(onLayoutScroll).toHaveBeenCalledOnce();
    expect(nextOwner).toHaveBeenCalledOnce();
    expect(reportedPositions).toEqual([5100, 5100]);
  });

  it('does not report a layout scroll when no visible anchor was available to restore', () => {
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);
    const onLayoutScroll = vi.fn();
    render(<ScrollHarness onLayoutScroll={onLayoutScroll} />);
    const observer = StubIntersectionObserver.instances[0];
    // jsdom reports zero-sized wrappers, just as a hidden transcript does.
    fireIntersection(observer, observer.observed[0], true);
    expect(onLayoutScroll).not.toHaveBeenCalled();
  });

  it.each([true, false])('reports an upward layout correction before scroll without changing follow intent (%s)', initiallyFollowing => {
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);
    let viewport: HTMLDivElement;
    let scrollTop = 3200;
    let previousTop = scrollTop;
    let isFollowing = initiallyFollowing;
    const onLayoutScroll = vi.fn(() => { previousTop = viewport.scrollTop; });
    const { container } = render(<ScrollHarness onLayoutScroll={onLayoutScroll} />);
    viewport = container.firstElementChild as HTMLDivElement;
    const observer = StubIntersectionObserver.instances[0];
    const rows = observer.observed as HTMLElement[];
    const height = (row: HTMLElement, index: number) => row.childElementCount ? (index === 0 ? 50 : 500) : 100;
    Object.defineProperty(viewport, 'scrollTop', { get: () => scrollTop, set: value => { scrollTop = value; } });
    Object.defineProperty(viewport, 'scrollHeight', { get: () => 4000 + rows.reduce((sum, row, index) => sum + height(row, index), 0) });
    viewport.getBoundingClientRect = () => ({ top: 0, bottom: 500, height: 500 } as DOMRect);
    rows.forEach((row, index) => {
      row.getBoundingClientRect = () => {
        const offset = 3000 + rows.slice(0, index).reduce((sum, previous, previousIndex) => sum + height(previous, previousIndex), 0);
        return { top: offset - scrollTop, bottom: offset - scrollTop + height(row, index), height: height(row, index), width: 100 } as DOMRect;
      };
    });
    viewport.addEventListener('scroll', () => {
      if (viewport.scrollTop < previousTop - 1) isFollowing = false;
      previousTop = viewport.scrollTop;
    });
    const oldHeight = viewport.scrollHeight;
    act(() => {
      observer.callback([rows[0], rows[3]].map(target => ({ target, isIntersecting: true, boundingClientRect: target.getBoundingClientRect() } as unknown as IntersectionObserverEntry)), observer as unknown as IntersectionObserver);
      viewport.dispatchEvent(new Event('scroll'));
    });
    // A shrinking estimate above the reader and growth below it yield upward
    // correction despite a larger total scrollHeight, without user navigation.
    expect(viewport.scrollHeight).toBeGreaterThan(oldHeight);
    expect(scrollTop).toBe(3150);
    expect(onLayoutScroll).toHaveBeenCalledOnce();
    expect(isFollowing).toBe(initiallyFollowing);
  });
});
