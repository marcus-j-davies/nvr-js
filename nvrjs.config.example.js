module.exports = {
	/* System Settings */
	system: {
		/* Username */
		username: "admin",
		/* bcrypt password (default: admin) */
		password: '$2a$10$CnOx/6vFY2ehRDf68yqd..aLlv0UM.zeBLKnRjuU8YykCsC2Ap3iG',
		/* bcrypt API Key (default: x7Te9m38JHQq6ddv) */
		apiKey: '$2a$10$N53ci.EIQ7JCu6u1HlOjoO//W0Bmp3GrRruyK1Jysr01CQ1rDrVQK',
		/* Any random string */
		cookieKey: 'f3gi6FLhIPVV31d1TBQUPEAngrI3wAoP',
		interfacePort: 7878,
		/* location used for 24/7 recording and database generation */
		/* This should be the root of a mount point i.e a dedicated HDD for 24/7 recordings */
		storageVolume: '/Volumes/CCTV',
		/* Continuous recording settings */
		ffmpegLocation: 'ffmpeg',
		continuousSegTimeMinutes: 15,
		continuousDays: 14,
		continuousPurgeIntervalHours: 24,
		/* event throttle per sensorId */
		eventSensorIdCoolOffSeconds: 60
	},
	/* Cameras */
	cameras: {
		'66e39d21-72c4-405c-a838-05a8e8fe0742': {
			name: 'Garage',
			/* Input Source Config */
			/* The keys and values represent the ffmpeg options */
			inputConfig: {
				use_wallclock_as_timestamps: '1',
				fflags: '+igndts',
				analyzeduration: '1000000',
				probesize: '1000000',
				rtsp_transport: 'tcp',
				stimeout: '30000000'
			},
			/* Input Address */
			input: 'rtsp://user:password@ip:port/live0',
			/* Recording 24/7 */
			/* Disabling continuous recording, will disable the ability to create events */
			continuous: true,
			/* Live streaming config */
			/* These settings should be good enough for a low delay live stream, providing your camera produces h264 frames */
			/* streaming is achieved with websockets and MP4 fragments */
			liveConfig: {
				codecString: 'video/mp4; codecs="avc1.64001f"',
				streamConfig: {
					an: '',
					vcodec: 'copy',
					f: 'mp4',
					movflags: '+frag_keyframe+empty_moov+default_base_moof',
					reset_timestamps: '1'
				}
			}
		}
	}
};
