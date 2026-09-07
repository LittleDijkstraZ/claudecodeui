import { memo, useCallback, useMemo } from 'react';

import { useUiPreferences, useSetUiPreference } from '@/shared/context/UiPreferencesContext';
import { useTheme } from '@/shared/context/ThemeContext';
import type { PreferenceToggleKey, QuickSettingsPreferences } from '@/shared/types';
import QuickSettingsContent from '@/modules/quick-settings-panel/QuickSettingsContent';

/** Exported as QuickSettingsPanel for the project-workspace drawer's retained preferences page. */
function QuickSettingsPanelView() {
  const { isDarkMode } = useTheme();
  const preferences = useUiPreferences();
  const setPreference = useSetUiPreference();
  const quickSettingsPreferences = useMemo<QuickSettingsPreferences>(() => ({
    showRawParameters: preferences.showRawParameters,
    showThinking: preferences.showThinking,
    sendByCtrlEnter: preferences.sendByCtrlEnter,
    voiceEnabled: preferences.voiceEnabled,
  }), [preferences.sendByCtrlEnter, preferences.showRawParameters, preferences.showThinking, preferences.voiceEnabled]);
  const handlePreferenceChange = useCallback((key: PreferenceToggleKey, value: boolean) => {
    setPreference(key, value);
  }, [setPreference]);
  return <div className="flex min-h-0 flex-1 flex-col" data-testid="workspace-preferences">
    <QuickSettingsContent isDarkMode={isDarkMode} preferences={quickSettingsPreferences} onPreferenceChange={handlePreferenceChange} />
  </div>;
}

export default memo(QuickSettingsPanelView);
