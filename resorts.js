/* ═══════════════════════════════════════════════
   MONITOR THE SKI-TUATION — resorts.js
   Canonical ski resort registry.
   Available as window.RESORTS before app.js loads.

   To add a resort: append an entry to the array below.
   To add a camera: append to a resort's cameras[] array.
     Set url: null if the webcam URL is unknown — the UI
     will show a "Camera link needed" placeholder.
   ═══════════════════════════════════════════════ */

window.RESORTS = [

  // ── ~15 min from Missoula ───────────────────
  {
    id: 'snowbowl',
    name: 'Montana Snowbowl',
    state: 'MT',
    distanceFromMissoulaMinutes: 15,
    websiteUrl: 'https://montanasnowbowl.com',
    lat: 46.9528,
    lng: -113.9987,
    cameras: [
      {
        id: 'ski-snowbowl-base',
        name: 'Base Area',
        url: 'https://g1.ipcamlive.com/player/snapshot.php?alias=690b67247173f',
        type: 'image',
        provider: 'IPCam Live',
      },
    ],
  },

  // ── ~75 min from Missoula ───────────────────
  {
    id: 'discovery',
    name: 'Discovery Ski Area',
    state: 'MT',
    distanceFromMissoulaMinutes: 75,
    websiteUrl: 'https://skidiscovery.com',
    lat: 46.4025,
    lng: -113.5085,
    cameras: [
      {
        id: 'ski-discovery-top',
        name: 'Top Overview',
        url: 'https://webcam.skidiscovery.com/webcam-images/top-overview/top-overview/top-overview-webcam.jpg',
        type: 'image',
        provider: 'Discovery',
      },
      {
        id: 'ski-discovery-od',
        name: 'OD Front',
        url: 'https://webcam.skidiscovery.com/webcam-images/od-front/od-front/od-front-webcam.jpg',
        type: 'image',
        provider: 'Discovery',
      },
      {
        id: 'ski-discovery-base',
        name: 'Base Stake',
        url: 'https://webcam.skidiscovery.com/webcam-images/base-stake/base-stake/base-stake-webcam.jpg',
        type: 'image',
        provider: 'Discovery',
      },
      {
        id: 'ski-discovery-topstk',
        name: 'Top Stake',
        url: 'https://webcam.skidiscovery.com/webcam-images/top-stake/top-stake/top-stake-webcam.jpg',
        type: 'image',
        provider: 'Discovery',
      },
    ],
  },

  {
    id: 'lookout-pass',
    name: 'Lookout Pass Ski & Recreation Area',
    state: 'MT/ID',
    distanceFromMissoulaMinutes: 75,
    websiteUrl: 'https://www.skilookout.com',
    lat: 47.4612,
    lng: -115.6973,
    cameras: [
      // Add webcam URL here when available
      { id: 'ski-lookout-1', name: 'Summit Cam', url: null, type: 'image', provider: null },
    ],
  },

  // ── ~90 min from Missoula ───────────────────
  {
    id: 'lost-trail',
    name: 'Lost Trail Powder Mountain',
    state: 'MT/ID',
    distanceFromMissoulaMinutes: 90,
    websiteUrl: 'https://www.losttrail.com',
    lat: 45.6956,
    lng: -113.9457,
    cameras: [
      // Add webcam URL here when available
      { id: 'ski-losttrail-1', name: 'Summit Cam', url: null, type: 'image', provider: null },
    ],
  },

  // ── ~105 min from Missoula ──────────────────
  {
    id: 'blacktail',
    name: 'Blacktail Mountain',
    state: 'MT',
    distanceFromMissoulaMinutes: 105,
    websiteUrl: 'https://www.blacktailmountain.com',
    lat: 47.9419,
    lng: -114.5289,
    cameras: [
      // Add webcam URL here when available
      { id: 'ski-blacktail-1', name: 'Slope Cam', url: null, type: 'image', provider: null },
    ],
  },

  {
    id: 'great-divide',
    name: 'Great Divide Ski Area',
    state: 'MT',
    distanceFromMissoulaMinutes: 105,
    websiteUrl: 'https://www.skidivide.com',
    lat: 46.8847,
    lng: -112.0939,
    cameras: [
      // Add webcam URL here when available
      { id: 'ski-greatdivide-1', name: 'Summit Cam', url: null, type: 'image', provider: null },
    ],
  },

  // ── ~120 min from Missoula ──────────────────
  {
    id: 'showdown',
    name: 'Showdown Montana',
    state: 'MT',
    distanceFromMissoulaMinutes: 120,
    websiteUrl: 'https://showdownmontana.com',
    lat: 46.8695,
    lng: -110.9003,
    cameras: [
      {
        id: 'ski-showdown-stake',
        name: 'Snow Stake',
        url: 'https://webcams.opensnow.com/current/4008.jpg',
        type: 'image',
        provider: 'OpenSnow',
      },
      {
        id: 'ski-showdown-payload',
        name: 'Payload Run',
        url: 'https://webcams.opensnow.com/current/247.jpg',
        type: 'image',
        provider: 'OpenSnow',
      },
      {
        id: 'ski-showdown-top',
        name: 'Top Rock',
        url: 'https://webcams.opensnow.com/current/249.jpg',
        type: 'image',
        provider: 'OpenSnow',
      },
    ],
  },

  // ── ~135 min from Missoula ──────────────────
  {
    id: 'whitefish',
    name: 'Whitefish Mountain Resort',
    state: 'MT',
    distanceFromMissoulaMinutes: 135,
    websiteUrl: 'https://skiwhitefish.com',
    lat: 48.4925,
    lng: -114.3561,
    cameras: [
      {
        id: 'ski-whitefish-base',
        name: 'Base Lodge',
        url: 'https://skiwhitefish.com/inbound/cams/newbaselodge.jpg',
        type: 'image',
        provider: 'Whitefish MT Resort',
      },
      {
        id: 'ski-whitefish-chair',
        name: 'Chair 1/2/6',
        url: 'https://skiwhitefish.com/inbound/cams/hellroaring_chalet.jpg',
        type: 'image',
        provider: 'Whitefish MT Resort',
      },
      {
        id: 'ski-whitefish-storm',
        name: 'Storm Cam',
        url: 'https://skiwhitefish.com/inbound/cams/2425_StumpyCam.jpg',
        type: 'image',
        provider: 'Whitefish MT Resort',
      },
    ],
  },

  {
    id: 'silver-mountain',
    name: 'Silver Mountain Resort',
    state: 'ID',
    distanceFromMissoulaMinutes: 135,
    websiteUrl: 'https://www.silvermt.com',
    lat: 47.5494,
    lng: -116.1066,
    cameras: [
      // Add webcam URL here when available
      { id: 'ski-silvermt-1', name: 'Village Cam', url: null, type: 'image', provider: null },
    ],
  },

];
