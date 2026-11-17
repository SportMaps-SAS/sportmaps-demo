// Monta el rastreo de uso (pantallas, botones, llamadas) mientras hay sesión.
// Telemetría agregada en el navegador: ver lib/usage/usageTracker.ts.

import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { bffClient } from '@/lib/api/bffClient';
import { getDisplayMode } from '@/pwa/tenant';
import { startUsageTracking, stopUsageTracking, trackScreen } from '@/lib/usage/usageTracker';

const CSRF_HEADERS = { 'X-Requested-With': 'SportMaps' };

export function useUsageTracking(): void {
    const { user } = useAuth();
    const { pathname } = useLocation();
    const userId = user?.id;

    useEffect(() => {
        if (!userId) return;
        startUsageTracking(
            (payload) => bffClient.post('/api/v1/usage', payload, CSRF_HEADERS),
            getDisplayMode,
        );
        return () => stopUsageTracking();
    }, [userId]);

    useEffect(() => {
        if (userId) trackScreen(pathname);
    }, [userId, pathname]);
}
