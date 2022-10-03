const express = require('express');
const cookieparser = require('cookie-parser');
const cookie = require('cookie');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const http = require('http');
const io = require('socket.io');
const handlebars = require('handlebars');
const childprocess = require('child_process');
const MP4Frag = require('./core/MP4Frag');
const fs = require('fs');
const os = require('os');
const path = require('path');
const osu = require('node-os-utils');
const sanitize = require('sanitize-filename');
const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
dayjs.extend(customParseFormat);
const RateLimiter = require('express-rate-limit');

/* Some static things */
const FileType = '.mp4';
const Index = {};
const SensorTimestamps = {};

/* Check and load config */
console.log(' - Checking config.');
if (!fs.existsSync(path.join(os.homedir(), 'nvrjs.config.js'))) {
	fs.copyFileSync(
		path.join(__dirname, 'nvrjs.config.example.js'),
		path.join(os.homedir(), 'nvrjs.config.js')
	);
	console.log(
		` - New config created: ${path.join(os.homedir(), 'nvrjs.config.js')}`
	);
	console.log(' - Edit config to suite and restart!');
	process.exit(0);
}
const config = require(path.join(os.homedir(), 'nvrjs.config.js'));
console.log(` - Config loaded: ${path.join(os.homedir(), 'nvrjs.config.js')}`);

/* Storage Volumes and folders */
console.log(' - Checking volumes and ffmpeg.');
if (!fs.existsSync(config.system.storageVolume)) {
	console.log(' - Storage volume does not exist');
	process.exit();
} else {
	try {
		if (
			!fs.existsSync(path.join(config.system.storageVolume, 'NVRJS_SYSTEM'))
		) {
			fs.mkdirSync(path.join(config.system.storageVolume, 'NVRJS_SYSTEM'));
		}
	} catch (e) {
		console.log('Error creating system directories.');
		console.log(e.message);
		process.exit(0);
	}
}

/* FFMPEG Check */
if (!fs.existsSync(config.system.ffmpegLocation)) {
	console.log(
		`ffmpeg not found in specifed location: ${config.system.ffmpegLocation}`
	);
	process.exit(0);
}

/* Protect web service from abuse */
const IOLimiter = RateLimiter({
	windowMs: 2000,
	max: 100
});

/* Configure WEB UI */
console.log(' - Creating express application.');
const App = new express();
App.use(IOLimiter);
App.use(express.json());
App.use(cookieparser(config.system.cookieKey));
const HTTP = new http.Server(App);

console.log(' - Compiling pages.');
const CompiledPages = {};
const Pages = {
	Dash: path.join(__dirname, 'web', 'dash.html'),
	Index: path.join(__dirname, 'web', 'index.html')
};
Object.keys(Pages).forEach((PS) => {
	CompiledPages[PS] = handlebars.compile(fs.readFileSync(Pages[PS], 'utf8'));
});

// Static
App.use('/static', express.static(path.join(__dirname, 'web', 'static')));

// UI
App.get('/', (req, res) => {
	if (
		config.system.disableUISecurity !== undefined &&
		config.system.disableUISecurity
	) {
		res.redirect('/dashboard');
	} else {
		res.type('text/html');
		res.status(200);
		res.end(CompiledPages.Index());
	}
});
App.post('/login', (req, res) => {
	const Data = req.body;
	const Password = Data.password;
	const Username = Data.username;

	if (
		bcrypt.compareSync(Password, config.system.password) &&
		config.system.username === Username
	) {
		res.cookie('Authentication', 'Success', {
			signed: true
		});
		res.status(204);
		res.end();
	} else {
		res.status(401);
		res.end();
	}
});

// Dashboard
App.get('/dashboard', CheckAuthMW, (req, res) => {
	res.type('text/html');
	res.status(200);
	res.end(CompiledPages.Dash(config));
});

// System Info (Uses shared API)
App.get('/systeminfo', CheckAuthMW, (req, res) => {
	getSystemInfo(req, res);
});

// Snapshot (Uses shared API)
App.get('/snapshot/:CameraID/:Width', CheckAuthMW, (req, res) => {
	getSnapShot(res, req.params.CameraID, req.params.Width);
});

// Get Event data (Uses shared API)
App.get('/geteventdata/:CameraID/:Start/:End', CheckAuthMW, (req, res) => {
	GetEventData(res, req.params.CameraID, req.params.Start, req.params.End);
});

/* Configure APIs */

// System Info
App.get('/api/:APIKey/systeminfo', (req, res) => {
	if (bcrypt.compareSync(req.params.APIKey, config.system.apiKey)) {
		getSystemInfo(req, res);
	} else {
		res.status(401);
		res.end();
	}
});

function getSystemInfo(req, res) {
	osu.cpu.usage().then((CPU) => {
		osu.drive.info(config.system.storageVolume).then((DISK) => {
			osu.mem.info().then((MEM) => {
				const Info = {
					CPU: CPU,
					DISK: DISK,
					MEM: MEM
				};
				res.type('application/json');
				res.status(200);
				res.end(JSON.stringify(Info));
			});
		});
	});
}

// Get Cameras
App.get('/api/:APIKey/cameras', (req, res) => {
	if (bcrypt.compareSync(req.params.APIKey, config.system.apiKey)) {
		const Cams = [];

		Object.keys(config.cameras).forEach((ID) => {
			const Cam = config.cameras[ID];
			Cams.push({
				id: ID,
				name: Cam.name,
				continuous: Cam.continuous
			});
		});

		res.type('application/json');
		res.status(200);
		res.end(JSON.stringify(Cams));
	} else {
		res.status(401);
		res.end();
	}
});

// Create Event
App.post('/event/:CameraID', CheckAuthMW, (req, res) => {
	Event(
		res,
		req.params.CameraID,
		req.body.event,
		req.body.sensorId,
		req.body.timestamp
	);
});

App.post('/api/:APIKey/event/:CameraID', (req, res) => {
	if (bcrypt.compareSync(req.params.APIKey, config.system.apiKey)) {
		Event(
			res,
			req.params.CameraID,
			req.body.event,
			req.body.sensorId,
			req.body.timestamp
		);
	} else {
		res.status(401);
		res.end();
	}
});

function Event(res, CameraID, Event, SensorID, Timestamp) {
	if (!config.cameras.hasOwnProperty(CameraID)) {
		res.status(404);
		res.end();
		return;
	}

	if (config.cameras[CameraID].continuous) {
		if (
			!SensorTimestamps.hasOwnProperty(SensorID) ||
			SensorID === 'LIVE-VIEW-EVENT'
		) {
			const Path = path.join(
				config.system.storageVolume,
				'NVRJS_SYSTEM',
				CameraID
			);

			const Last = Math.max(
				...Object.keys(Index[CameraID]).map((E) => parseInt(E))
			);
			const PHFOP = path.join(Path, Index[CameraID][Last]);
			const PHFO = ReadMetaFile(PHFOP);

			if (PHFO !== false) {
				PHFO.events.push({
					eventId: generateUUID(),
					event: Event,
					sensorId: SensorID,
					timestamp: Timestamp
				});

				const FP = path.join(Path, PHFO.segment.metaFileName);
				if (WriteMetaFile(PHFO, FP)) {
					res.status(204);
					res.end();

					SensorTimestamps[SensorID] = dayjs().unix();

					setTimeout(() => {
						delete SensorTimestamps[SensorID];
					}, 1000 * config.system.eventSensorIdCoolOffSeconds);
				} else {
					res.status(500);
					res.end();
				}
			} else {
				res.status(500);
				res.end();
			}
		} else {
			res.status(429);
			res.end();
		}
	} else {
		res.status(501);
		res.end();
	}
}

// Snapshot
App.get('/api/:APIKey/snapshot/:CameraID/:Width', (req, res) => {
	if (bcrypt.compareSync(req.params.APIKey, config.system.apiKey)) {
		getSnapShot(res, req.params.CameraID, req.params.Width);
	} else {
		res.status(401);
		res.end();
	}
});

function getSnapShot(Res, CameraID, Width) {
	const CommandArgs = [];
	const Cam = config.cameras[CameraID];

	Object.keys(Cam.inputConfig).forEach((inputConfigKey) => {
		CommandArgs.push('-' + inputConfigKey);
		if (Cam.inputConfig[inputConfigKey].length > 0) {
			CommandArgs.push(Cam.inputConfig[inputConfigKey]);
		}
	});

	CommandArgs.push('-i');
	CommandArgs.push(Cam.input);
	CommandArgs.push('-vf');
	CommandArgs.push('scale=' + Width + ':-1');
	CommandArgs.push('-vframes');
	CommandArgs.push('1');
	CommandArgs.push('-f');
	CommandArgs.push('image2');
	CommandArgs.push('-');

	const Process = childprocess.spawn(
		config.system.ffmpegLocation,
		CommandArgs,
		{ env: process.env, stderr: 'ignore' }
	);

	let imageBuffer = Buffer.alloc(0);

	Process.stdout.on('data', function (data) {
		imageBuffer = Buffer.concat([imageBuffer, data]);
	});

	Process.on('exit', (Code, Signal) => {
		const _Error = FFMPEGExitDueToError(Code, Signal);
		if (!_Error) {
			Res.type('image/jpeg');
			Res.status(200);
			Res.end(Buffer.from(imageBuffer, 'binary'));
		} else {
			Res.status(500);
			Res.end();
		}
	});
}

// Get Event Data
App.get('/api/:APIKey/geteventdata/:CameraID/:Start/:End', (req, res) => {
	if (bcrypt.compareSync(req.params.APIKey, config.system.apiKey)) {
		GetEventData(res, req.params.CameraID, req.params.Start, req.params.End);
	} else {
		res.status(401);
		res.end();
	}
});

function GetEventData(res, CameraID, Start, End) {
	const ID = sanitize(CameraID);

	const Data = {
		segments: []
	};

	const Segments = Object.keys(Index[ID]).filter(
		(K) => parseInt(K) >= parseInt(Start) && parseInt(K) <= parseInt(End)
	);

	Segments.forEach((K) => {
		const FilePath = path.join(
			config.system.storageVolume,
			'NVRJS_SYSTEM',
			ID,
			Index[ID][K]
		);

		const PL = ReadMetaFile(FilePath);
		if (PL !== false) {
			Data.segments.push(PL);
		}
	});

	res.type('application/json');
	res.status(200);
	res.end(JSON.stringify(Data));
}

/* FFMPEG Exit code check */
function FFMPEGExitDueToError(Code, Signal) {
	if (Code == null && Signal === 'SIGKILL') {
		return false;
	}
	if (Code === 255 && Signal == null) {
		return false;
	}
	if (Code > 0 && Code < 255 && Signal == null) {
		return true;
	}
}

/* Start up cameras */
const Cameras = Object.keys(config.cameras);
Cameras.forEach((cameraID) => {
	const Cam = config.cameras[cameraID];
	InitCamera(Cam, cameraID);
});

/* Start Purge timer */
console.log(' - Strting purge timer.');
setInterval(
	purgeContinuous,
	60000 * 60 * config.system.continuousPurgeIntervalHours
);

/* Create PlaceHolder Metafile */
function CreatePlaceHolderMeta(CameraID) {
	const Path = path.join(config.system.storageVolume, 'NVRJS_SYSTEM', CameraID);
	const Start = dayjs().unix();

	const Meta = {
		segment: {
			metaFileName: `${Start}_placeholder.json`,
			cameraId: CameraID,
			startTime: Start,
			fileName: undefined,
			endTime: 0,
			checksum: 0,
			segmentId: generateUUID()
		},
		events: []
	};

	const FP = path.join(Path, Meta.segment.metaFileName);
	if (WriteMetaFile(Meta, FP)) {
		Index[CameraID][Start] = Meta.segment.metaFileName;
		return true;
	} else {
		return false;
	}
}

/* Create Metafile */
function CreateMeta(CameraID, fileName) {
	fileName = fileName.trim().replace(/\n/g, '');
	const Path = path.join(config.system.storageVolume, 'NVRJS_SYSTEM', CameraID);

	const Start = parseInt(fileName.split('.')[0]);
	const End = dayjs().unix();

	const Meta = {
		segment: {
			metaFileName: fileName.replace(FileType, '.json'),
			cameraId: CameraID,
			fileName: fileName,
			startTime: Start,
			endTime: End,
			checksum: 0,
			segmentId: generateUUID()
		},
		events: []
	};

	const fileBuffer = fs.readFileSync(path.join(Path, fileName));
	const HashSum = crypto.createHash('sha256');
	HashSum.update(fileBuffer);

	const Hex = HashSum.digest('hex');
	Meta.segment.checksum = `sha256:${Hex}`;

	const Last = Math.max(
		...Object.keys(Index[CameraID]).map((E) => parseInt(E))
	);

	const PHFOP = path.join(Path, Index[CameraID][Last]);
	const PHFO = ReadMetaFile(PHFOP);

	if (PHFO !== false) {
		Meta.events = PHFO.events;
		if (WriteMetaFile(Meta, path.join(Path, Meta.segment.metaFileName))) {
			delete Index[CameraID][Last];
			fs.unlinkSync(PHFOP);
			Index[CameraID][Start] = Meta.segment.metaFileName;
			CreatePlaceHolderMeta(CameraID);
		}
	}
}

/* Camera Initer */
function InitCamera(Cam, cameraID) {
	console.log(` - Configuring camera: ${Cam.name}`);

	const Path = path.join(config.system.storageVolume, 'NVRJS_SYSTEM', cameraID);
	if (!fs.existsSync(Path)) {
		fs.mkdirSync(Path);
	}

	Index[cameraID] = {};

	const SegMetaFiles = fs
		.readdirSync(Path)
		.filter(
			(File) => path.extname(File) === '.json' && !File.includes('_placeholder')
		);

	SegMetaFiles.forEach((MF) => {
		const MD = ReadMetaFile(path.join(Path, MF));
		if (MD !== false) {
			Index[cameraID][MD.segment.startTime] = MD.segment.metaFileName;
		}
	});

	const CommandArgs = [];

	Object.keys(Cam.inputConfig).forEach((inputConfigKey) => {
		if (inputConfigKey !== 'i') {
			CommandArgs.push('-' + inputConfigKey);
			if (Cam.inputConfig[inputConfigKey].length > 0) {
				CommandArgs.push(Cam.inputConfig[inputConfigKey]);
			}
		}
	});

	CommandArgs.push('-i');
	CommandArgs.push(Cam.input);

	App.use(
		'/segments/' + cameraID,
		CheckAuthMW,
		express.static(
			path.join(config.system.storageVolume, 'NVRJS_SYSTEM', cameraID),
			{ acceptRanges: true }
		)
	);

	if (Cam.continuous !== undefined && Cam.continuous) {
		let CV = 'copy';
		let CA = 'copy';

		if (Cam.postInput !== undefined) {
			if (Cam.postInput.videoEncoder !== undefined) {
				CV = Cam.postInput.videoEncoder;
			}
			if (Cam.postInput.audioEncoder !== undefined) {
				CA = Cam.postInput.audioEncoder;
			}
		}
		CommandArgs.push('-c:v');
		CommandArgs.push(CV);

		if (
			Cam.postInput !== undefined &&
			Cam.postInput.videoAdditional !== undefined
		) {
			Object.keys(Cam.postInput.videoAdditional).forEach((EK) => {
				CommandArgs.push(`-${EK}`);
				CommandArgs.push(Cam.postInput.videoAdditional[EK]);
			});
		}

		CommandArgs.push('-c:a');
		CommandArgs.push(CA);

		if (
			Cam.postInput !== undefined &&
			Cam.postInput.audioAdditional !== undefined
		) {
			Object.keys(Cam.postInput.audioAdditional).forEach((EK) => {
				CommandArgs.push(`-${EK}`);
				CommandArgs.push(Cam.postInput.audioAdditional[EK]);
			});
		}

		CommandArgs.push('-f');
		CommandArgs.push('segment');
		CommandArgs.push('-segment_atclocktime');
		CommandArgs.push('1');
		CommandArgs.push('-reset_timestamps');
		CommandArgs.push('1');
		CommandArgs.push('-strftime');
		CommandArgs.push('1');
		CommandArgs.push('-segment_list');
		CommandArgs.push('pipe:4');
		CommandArgs.push('-segment_time');
		CommandArgs.push(60 * config.system.continuousSegTimeMinutes);
		CommandArgs.push('-movflags');
		CommandArgs.push('+faststart');
		CommandArgs.push(path.join(Path, `%s${FileType}`));
	}

	Object.keys(Cam.liveConfig.streamConfig).forEach((streamingConfigKey) => {
		CommandArgs.push('-' + streamingConfigKey);
		if (Cam.liveConfig.streamConfig[streamingConfigKey].length > 0) {
			CommandArgs.push(Cam.liveConfig.streamConfig[streamingConfigKey]);
		}
	});

	CommandArgs.push('-metadata');
	CommandArgs.push('title="NVR JS Stream"');
	CommandArgs.push('pipe:3');

	const Options = {
		detached: true,
		stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']
	};
	const respawn = (Spawned, PrevSock) => {
		const MP4F = new MP4Frag();

		const IOptions = {
			path: '/streams/' + cameraID
		};
		const Socket = PrevSock || io(HTTP, IOptions); // avoid adding a ton of listeners to the same HTTP server
		if (!PrevSock) {
			Socket.on('connection', (ClientSocket) => {
				if (CheckAuthMW(ClientSocket)) {
					ClientSocket.emit('segment', MP4F.initialization);
				}
			});
		}

		MP4F.on('segment', (data) => {
			Socket.sockets.sockets.forEach((ClientSocket) => {
				ClientSocket.emit('segment', data);
			});
		});

		Spawned.on('close', () => {
			console.log(
				` - Camera: ${Cam.name}  was terminated, respawning after 10 seconds...`
			);
			Spawned.kill();
			MP4F.destroy();
			setTimeout(() => {
				respawn(
					childprocess.spawn(
						config.system.ffmpegLocation,
						CommandArgs,
						Options
					),
					Socket
				);
			}, 10000);
		});

		Spawned.stdio[3].on('data', (data) => {
			MP4F.write(data, 'binary');
		});
		Spawned.stdio[4].on('data', (FN) => {
			CreateMeta(cameraID, FN.toString());
		});

		return Spawned;
	};

	const Process = respawn(
		childprocess.spawn(config.system.ffmpegLocation, CommandArgs, Options)
	);

	if (!CreatePlaceHolderMeta(cameraID)) {
		Process.removeAllListeners('close');
		Process.kill();
		console.log(
			`   - Could not kick start segment management for camera: ${Cam.name}`
		);
		console.log(`   - Camera will not be started.`);
	} else {
		console.log(`   - Camera: ${Cam.name} started.`);
	}
}

/* Gen ID */
function generateUUID() {
	var d = new Date().getTime();
	var d2 =
		(typeof performance !== 'undefined' &&
			performance.now &&
			performance.now() * 1000) ||
		0;
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
		var r = Math.random() * 16;
		if (d > 0) {
			r = (d + r) % 16 | 0;
			d = Math.floor(d / 16);
		} else {
			r = (d2 + r) % 16 | 0;
			d2 = Math.floor(d2 / 16);
		}
		return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
	});
}

/* Logged in check */
function CheckAuthMW(req, res, next) {
	const NonInteractive = res === undefined && next === undefined;

	if (
		config.system.disableUISecurity !== undefined &&
		config.system.disableUISecurity
	) {
		if (NonInteractive) {
			return true;
		} else {
			next();
		}
	} else {
		if (NonInteractive) {
			if (req.handshake.headers.cookie !== undefined) {
				const CS = cookie.parse(req.handshake.headers.cookie);
				const Signed = cookieparser.signedCookies(CS, config.system.cookieKey);
				if (
					Signed.Authentication === undefined ||
					Signed.Authentication !== 'Success'
				) {
					req.disconnect();
					return false;
				} else {
					return true;
				}
			} else {
				req.disconnect();
				return false;
			}
		} else {
			if (
				req.signedCookies.Authentication === undefined ||
				req.signedCookies.Authentication !== 'Success'
			) {
				res.status(401);
				res.end();
			} else {
				next();
			}
		}
	}
}

/* Purge */
function purgeContinuous() {
	console.log(' - Purging data.');

	const Date = dayjs().subtract(config.system.continuousDays, 'day').unix();

	Object.keys(Index).forEach((K) => {
		const Files = Object.keys(Index[K]).filter((TSK) => parseInt(TSK) <= Date);
		Files.forEach((F) => {
			const Path = path.join(config.system.storageVolume, 'NVRJS_SYSTEM', K);
			delete Index[K][F]; // Index Entry
			try {
				fs.unlinkSync(path.join(Path, `${F}.json`)); // Metafile
			} catch (e) {
				// file couldn't be removed, likely due to permission issue, flaky disk etc.
				// not anything we can do about it, but don't crash.
			}
			try {
				fs.unlinkSync(path.join(Path, `${F}${FileType}`)); // footage
			} catch (e) {
				// ditto
			}
		});
	});
}

/* Write Operation */
function WriteMetaFile(OBJ, FilePath) {
	try {
		fs.writeFileSync(FilePath, JSON.stringify(OBJ));
		return true;
	} catch (Err) {
		return false;
	}
}

/* Read Operation */
function ReadMetaFile(FilePath) {
	try {
		const Result = fs.readFileSync(FilePath, 'utf8');
		const OBJ = JSON.parse(Result);
		return OBJ;
	} catch (Err) {
		return false;
	}
}

HTTP.listen(config.system.interfacePort);
console.log(' - NVR JS is Ready!');

/* Why not */
setTimeout(purgeContinuous, 1000);
