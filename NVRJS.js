const express = require('express');
const cookieparser = require('cookie-parser');
const bcrypt = require('bcrypt');
const http = require('http');
const io = require('socket.io');
const handlebars = require('handlebars');
const childprocess = require('child_process');
const MP4Frag = require('./core/MP4Frag');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sql = require('sqlite3');
const osu = require('node-os-utils');
const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
dayjs.extend(customParseFormat);

console.log(' - Checking config.');
if (!fs.existsSync(path.join(os.homedir(), 'nvrjs.config.js'))) {
	fs.copyFileSync(
		path.join(__dirname, 'nvrjs.config.example.js'),
		path.join(os.homedir(), 'nvrjs.config.js')
	);
	console.log(
		' - New config created: ' + path.join(os.homedir(), 'nvrjs.config.js')
	);
	console.log(' - Edit config to suite and restart!');
	process.exit(0);
}
const config = require(path.join(os.homedir(), 'nvrjs.config.js'));
console.log(' - Config loaded: ' + path.join(os.homedir(), 'nvrjs.config.js'));

let SQL;
const SensorTimestamps = {};

console.log(' - Checking directoires and ffmpeg.');

if (!fs.existsSync(config.system.storageLocation)) {
	try {
		console.log(' - Creating storage directories.');
		fs.mkdirSync(config.system.storageLocation, { recursive: true });
		fs.mkdirSync(path.join(config.system.storageLocation, 'system'));
		fs.mkdirSync(path.join(config.system.storageLocation, 'cameras'));
	} catch (e) {
		console.log('Error creating storage directory.');
		console.log(e.message);
		process.exit(0);
	}
}

if (!fs.existsSync(config.system.ffmpegLocation)) {
	console.log(
		'ffmpeg not found in specifed location: ' + config.system.ffmpegLocation
	);
	process.exit(0);
}

CreateOrConnectSQL(() => {
	console.log(' - Starting purge interval.');
	setInterval(
		purgeContinuous,
		1000 * 3600 * config.system.continuousPurgeIntervalHours
	);
	purgeContinuous();
});

console.log(' - Creating express application.');
const App = new express();
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

App.use('/static', express.static(path.join(__dirname, 'web', 'static')));

App.get('/systeminfo', CheckAuthMW, (req, res) => {
	osu.cpu.usage().then((CPU) => {
		osu.drive.info().then((DISK) => {
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
});

App.get('/', (req, res) => {
	res.type('text/html');
	res.status(200);
	res.end(CompiledPages.Index());
});
App.post('/login', (req, res) => {
	const Data = req.body;
	const Password = Data.password;

	if (bcrypt.compareSync(Password, config.system.password)) {
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
App.get('/dashboard', CheckAuthMW, (req, res) => {
	res.type('text/html');
	res.status(200);
	res.end(CompiledPages.Dash(config));
});

App.get('/geteventdata/:CameraID/:Start/:End', CheckAuthMW, (req, res) => {
	const Data = {};

	let STMT = SQL.prepare(
		'SELECT * FROM Segments WHERE CameraID = ? AND Start >= ? AND End <= ?'
	);
	STMT.all(
		[req.params.CameraID, parseInt(req.params.Start), parseInt(req.params.End)],
		function (err, rows) {
			Data.segments = rows;
			STMT.finalize();
			STMT = SQL.prepare(
				'SELECT * FROM Events WHERE CameraID = ? AND Date >= ? AND Date <= ?'
			);
			STMT.all(
				[
					req.params.CameraID,
					parseInt(req.params.Start),
					parseInt(req.params.End)
				],
				function (err, rows) {
					Data.events = rows;
					STMT.finalize();
					res.type('application/json');
					res.status(200);
					res.end(JSON.stringify(Data));
				}
			);
		}
	);
});

App.get('/snapshot/:CameraID/:Width', CheckAuthMW, (req, res) => {
	const CommandArgs = [];
	const Cam = config.cameras[req.params.CameraID];

	Object.keys(Cam.inputConfig).forEach((inputConfigKey) => {
		CommandArgs.push('-' + inputConfigKey);
		if (Cam.inputConfig[inputConfigKey].length > 0) {
			CommandArgs.push(Cam.inputConfig[inputConfigKey]);
		}
	});

	CommandArgs.push('-i');
	CommandArgs.push(Cam.input);
	CommandArgs.push('-vf');
	CommandArgs.push('scale=' + req.params.Width + ':-1');
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
			res.type('image/jpeg');
			res.status(200);
			res.end(Buffer.from(imageBuffer, 'binary'));
		} else {
			res.status(500);
			res.end();
		}
	});
});

App.post('/event/:Password/:CameraID', (req, res) => {
	if (bcrypt.compareSync(req.params.Password, config.system.password)) {
		if (config.cameras[req.params.CameraID].continuous) {
			if (!SensorTimestamps.hasOwnProperty(req.body.sensorId)) {
				const STMT = SQL.prepare(
					'INSERT INTO Events(EventID,CameraID,Name,SensorID,Date) VALUES(?,?,?,?,?)'
				);
				STMT.run([
					generateUUID(),
					req.params.CameraID,
					req.body.name,
					req.body.sensorId,
					req.body.date
				]);
				STMT.finalize();

				res.status(204);
				res.end();

				SensorTimestamps[req.body.sensorId] = dayjs().unix();

				setTimeout(() => {
					delete SensorTimestamps[req.body.sensorId];
				}, 1000 * config.system.eventSensorIdCoolOffSeconds);

				return;
			}
			res.status(429);
			res.end();
		} else {
			res.status(501);
			res.end();
		}
	} else {
		res.status(401);
		res.end();
	}
});

const Processors = {};
const Cameras = Object.keys(config.cameras);
Cameras.forEach((cameraID) => {
	const Cam = config.cameras[cameraID];
	InitCamera(Cam, cameraID);
});

function CreateOrConnectSQL(CB) {
	const Path = path.join(config.system.storageLocation, 'system', 'data.db');

	if (!fs.existsSync(Path)) {
		console.log(' - Creating db structure.');
		SQL = new sql.Database(Path, function () {
			SQL.run(
				'CREATE TABLE Segments(SegmentID TEXT, CameraID TEXT, FileName TEXT, Start NUMERIC, End NUMERIC)',
				function () {
					SQL.run(
						'CREATE TABLE Events(EventID TEXT,CameraID TEXT, Name TEXT, SensorID TEXT, Date NUMERIC)',
						function () {
							SQL.close();
							console.log(' - Connecting to db.');
							SQL = new sql.Database(Path, CB);
						}
					);
				}
			);
		});
	} else {
		console.log(' - Connecting to db.');
		SQL = new sql.Database(Path, CB);
	}
}

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

function InitCamera(Cam, cameraID) {
	console.log(' - Configuring camera: ' + Cam.name);

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
			path.join(config.system.storageLocation, 'cameras', cameraID),
			{ acceptRanges: true }
		)
	);

	if (Cam.continuous !== undefined && Cam.continuous) {
		let Path = path.join(config.system.storageLocation, 'cameras', cameraID);
		if (!fs.existsSync(Path)) {
			fs.mkdirSync(Path);
		}

		Path = path.join(Path, '%Y-%m-%dT%H-%M-%S.mp4');

		CommandArgs.push('-c:v');
		CommandArgs.push('copy');
		CommandArgs.push('-c:a');
		CommandArgs.push('copy');
		CommandArgs.push('-f');
		CommandArgs.push('segment');
		CommandArgs.push('-movflags');
		CommandArgs.push('+faststart');
		CommandArgs.push('-segment_atclocktime');
		CommandArgs.push('1');
		CommandArgs.push('-reset_timestamps');
		CommandArgs.push('1');
		CommandArgs.push('-strftime');
		CommandArgs.push('1');
		CommandArgs.push('-segment_list');
		CommandArgs.push('pipe:3');
		CommandArgs.push('-segment_time');
		CommandArgs.push(60 * config.system.continuousSegTimeMinutes);
		CommandArgs.push(Path);
	}

	Object.keys(Cam.liveConfig.streamConfig).forEach((streamingConfigKey) => {
		CommandArgs.push('-' + streamingConfigKey);
		if (Cam.liveConfig.streamConfig[streamingConfigKey].length > 0) {
			CommandArgs.push(Cam.liveConfig.streamConfig[streamingConfigKey]);
		}
	});

	CommandArgs.push('-metadata');
	CommandArgs.push('title="NVR JS Stream"');
	CommandArgs.push('pipe:1');

	const MP4F = new MP4Frag();
	const Process = new childprocess.spawn(
		config.system.ffmpegLocation,
		CommandArgs,
		{ detached: true, stdio: ['ignore', 'pipe', 'ignore', 'pipe'] }
	);

	Process.stdio[1].pipe(MP4F);
	Process.stdio[3].on('data', (FN) => {
		if (Processors[cameraID] !== undefined) {
			const FileName = FN.toString().trim().replace(/\n/g, '');
			const Start = dayjs(
				FileName.replace(/.mp4/g, ''),
				'YYYY-MM-DDTHH-mm-ss'
			).unix();
			const End = dayjs().unix();
			const STMT = SQL.prepare(
				'INSERT INTO Segments(SegmentID,CameraID,FileName,Start,End) VALUES(?,?,?,?,?)'
			);
			STMT.run([generateUUID(), cameraID, FileName, Start, End]);
			STMT.finalize();
		}
	});

	const IOptions = {
		path: '/streams/' + cameraID
	};
	const Socket = io(HTTP, IOptions);

	MP4F.on('segment', (data) => {
		Socket.sockets.sockets.forEach((ClientSocket) => {
			ClientSocket.emit('segment', data);
		});
	});

	Socket.on('connection', (ClientSocket) => {
		ClientSocket.emit('segment', MP4F.initialization);
	});

	Processors[cameraID] = {
		CameraInfo: Cam,
		Socket: Socket,
		FFMPEG: Process,
		MP4Frag: MP4F
	};
}
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

function CheckAuthMW(req, res, next) {
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

async function purgeContinuous() {
	console.log(' - Purging data.');
	const Date = dayjs().subtract(config.system.continuousDays, 'day').unix();
	const STMT = SQL.prepare('SELECT * FROM Segments WHERE Start <= ?');
	STMT.all([Date], function (err, rows) {
		rows.forEach((S) => {
			fs.unlinkSync(
				path.join(
					config.system.storageLocation,
					'cameras',
					S.CameraID,
					S.FileName
				)
			);
		});
		SQL.run(`DELETE FROM Segments WHERE Start <= ${Date}`, function () {
			SQL.run(`DELETE FROM Events WHERE Date <= ${Date}`);
		});
	});
}

HTTP.listen(config.system.interfacePort);
console.log(' - NVR JS is Ready!');
