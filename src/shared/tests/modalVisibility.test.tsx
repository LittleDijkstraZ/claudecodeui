import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { useModalVisibility } from '@/shared/hooks/useModalVisibility';
import { Dialog, DialogContent } from '@/shared/ui';

function Coverage() { return <output data-testid="covered">{String(useModalVisibility())}</output>; }
function Fixture({ first, second }: { first: boolean; second: boolean }) {
  return <><Coverage /><Dialog open={first}><DialogContent>First</DialogContent></Dialog><Dialog open={second}><DialogContent>Second</DialogContent></Dialog></>;
}

test('dialog coverage remains until the last dialog closes and cleans up on workspace unmount', () => {
  const view = render(<Fixture first={false} second={false} />);
  expect(screen.getByTestId('covered').textContent).toBe('false');
  view.rerender(<Fixture first second={false} />);
  expect(screen.getByTestId('covered').textContent).toBe('true');
  view.rerender(<Fixture first second />);
  view.rerender(<Fixture first={false} second />);
  expect(screen.getByTestId('covered').textContent).toBe('true');
  view.unmount(); render(<Coverage />);
  expect(screen.getByTestId('covered').textContent).toBe('false');
});
