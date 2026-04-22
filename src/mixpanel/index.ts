import Constants, { ExecutionEnvironment } from 'expo-constants';

const trackAutomaticEvents = true; // disable legacy autotrack mobile events
const MIXPANEL_TOKEN = 'bd1915e9683b5b28633f8ba7e6add4ea';
const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

type MixpanelClient = {
    init: () => void;
    track: (eventName: string) => void;
    identify: (userId: string) => void;
    timeEvent: (eventName: string, time?: number) => void;
};

const noopMixpanel: MixpanelClient = {
    init: () => undefined,
    track: () => undefined,
    identify: () => undefined,
    timeEvent: () => undefined,
};

let mixpanelClient: MixpanelClient | null = null;

const getMixpanel = (): MixpanelClient => {
    if (mixpanelClient) return mixpanelClient;
    if (isExpoGo) {
        mixpanelClient = noopMixpanel;
        return mixpanelClient;
    }

    const { Mixpanel } = require('mixpanel-react-native');
    const client = new Mixpanel(MIXPANEL_TOKEN, trackAutomaticEvents);
    mixpanelClient = client;
    return client;
};

const initMixpanel = () => {
    getMixpanel().init();
}

const trackEvent = (eventName: string) => {
    getMixpanel().track(eventName);
}

const identifyUser = (userId: string) => {
    getMixpanel().identify(userId);
}

const timingEvent = (eventName: string, time?: number) => {
    getMixpanel().timeEvent(eventName);
}

const stopTimingEvent = (eventName: string) => {
    getMixpanel().track(eventName);
}

const mixpanel: MixpanelClient = {
    init: initMixpanel,
    track: trackEvent,
    identify: identifyUser,
    timeEvent: timingEvent,
};

export {
    mixpanel,
    initMixpanel,
    trackEvent,
    identifyUser,
    timingEvent,
    stopTimingEvent,
}
