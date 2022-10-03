/* eslint-disable no-unused-vars */
/* eslint-disable no-undef */
const SearchTimebufferHours = 2;
let Segments = [];
let VideoFile;

function StartStats() {
	const Update = () => {
		$.ajax({
			type: 'GET',
			url: '/systeminfo',
			dataType: 'json',
			success: function (data) {
				$('#CPU').html(data.CPU + '%');
				$('#RAM').html(data.MEM.usedMemPercentage + '%');
				$('#DISK').html(data.DISK.usedPercentage + '%');
			}
		});
	};
	Update();
	setInterval(() => {
		Update();
	}, 5000);
}

function StartTimeline(ID, Name) {
	const contents = $('#scrub').html();
	const copy = $('<div style="padding:5px" id="' + ID + '"></div>');
	copy.append(contents);
	copy.dialog({
		width: 855,
		height: 630,
		modal: true,
		title: Name + ' Timeline Viewer',
		close: function () {
			const VideoElement = copy.find('video');
			const VE5 = $(VideoElement)[0];
			VE5.pause();
			VE5.remove();
			VideoFile = undefined;
		}
	});

	const TimelineDiv = copy.find('#timeline');
	const TL = $(TimelineDiv)[0];

	const Groups = new vis.DataSet([
		{ content: 'Video', id: 'Video', value: 1 },
		{ content: 'Events', id: 'Events', value: 2 }
	]);

	const Items = new vis.DataSet([
		{ id: 1, content: 'Display Fix', start: '2000-01-01' }
	]);

	const Options = {
		start: dayjs().subtract(1, 'hour').toDate(),
		end: dayjs().add(15, 'minutes').toDate(),
		groupOrder: function (a, b) {
			return a.value - b.value;
		},
		height: 150,
		editable: false,
		groupEditable: false,
		stack: false,
		rollingMode: {
			follow: false,
			offset: 0.5
		}
	};

	// create a Timeline
	const timeline = new vis.Timeline(TL, Items, Groups, Options);
	Items.remove(1);

	let CommitTimeout;
	let isMoving = false;
	timeline.on('rangechange', (event) => {
		clearTimeout(CommitTimeout);
		isMoving = true;
	});
	timeline.on('rangechanged', (event) => {
		CommitTimeout = setTimeout(() => {
			const Start = dayjs(event.start)
				.subtract(SearchTimebufferHours, 'hour')
				.unix();
			const End = dayjs(event.end).add(SearchTimebufferHours, 'hour').unix();
			GetSegmentsAndEvents(timeline, Items, Start, End, ID);
			isMoving = false;
		}, 500);
	});
	timeline.on('click', (event) => {
		if (!isMoving) {
			timeline.setCurrentTime(event.time);
			LoadAndPosition(timeline, event.time, copy, ID);
		}
		isMoving = false;
	});
}

function LoadAndPosition(Timeline, Date, Copy, ID) {
	const VideoElement = Copy.find('video');
	const VE5 = $(VideoElement)[0];
	const Time = dayjs(Date).unix();
	const MatchedSegments = Segments.filter(
		(S) => S.segment.startTime <= Time && S.segment.endTime >= Time
	);

	if (MatchedSegments.length > 0) {
		const Seg = MatchedSegments[0];

		if (Seg.segment.fileName !== undefined) {
			const VideoStart = Seg.segment.startTime;

			const URL = '/segments/' + ID + '/' + Seg.segment.fileName;

			let StartTime = Time - VideoStart;
			if (StartTime < 0) {
				StartTime = 0;
			}

			if (VideoFile === undefined || VideoFile !== URL) {
				if (!VE5.paused) {
					VE5.pause();
				}

				VideoElement.off('timeupdate');
				VideoElement.on('timeupdate', (event) => {
					const Date = dayjs
						.unix(Seg.segment.startTime)
						.add(VE5.currentTime, 'second')
						.toDate();
					Timeline.setCurrentTime(Date);
				});

				VideoElement.one('loadedmetadata', () => {
					VE5.currentTime = StartTime;
					VE5.play();
				});

				VideoElement.one('canplay', () => {
					//VE5.play();
				});
				VE5.src = '/segments/' + ID + '/' + Seg.segment.fileName;
				VideoFile = URL;
			} else {
				VE5.currentTime = StartTime;
				if (VE5.paused) {
					VE5.play();
				}
			}
		}
	}
}

function EventSort(a, b) {
	return a.segment.startTime - b.segment.startTime;
}

function GetSegmentsAndEvents(Timeline, DataSet, Start, End, ID) {
	$.getJSON('/geteventdata/' + ID + '/' + Start + '/' + End, function (data) {
		data.segments.sort(EventSort);
		Segments = data.segments;

		DataSet.clear();
		for (let i = 0; i < data.segments.length; i++) {
			const Seg = data.segments[i];
			const Start = dayjs.unix(Seg.segment.startTime);
			const End = dayjs.unix(Seg.segment.endTime);

			DataSet.add({
				start: Start.toDate(),
				end: End.toDate(),
				type: 'background',
				group: 'Video',
				content: Start.format('YYYY-MM-DD HH:mm:ss'),
				style:
					'background-color: rgba(0,0,0,0.5);color: white;border-radius: 6px;',
				fileName: Seg.segment.fileName,
				cameraId: Seg.segment.cameraId,
				segmentId: Seg.segment.segmentId
			});

			for (let i = 0; i < Seg.events.length; i++) {
				const Event = Seg.events[i];
				const Start = dayjs.unix(Event.timestamp);

				DataSet.add({
					start: Start.toDate(),
					group: 'Events',
					content: Event.event,
					style: 'background-color: orangered;color: white;border-radius: 6px;'
				});
			}
		}

		Timeline.redraw();
	});
}

function StartLive(ID, Name, Codec) {
	let buffer;
	let socket;

	const contents = $('#liveView').html();
	const copy = $('<div style="padding:5px" id="' + ID + '"></div>');
	copy.append(contents);
	const VideoElement = copy.find('video');
	const VE5 = $(VideoElement)[0];
	copy.dialog({
		width: 520,
		height: 410,
		title: Name + ' (Live)',
		close: function () {
			socket.disconnect();
			VE5.pause();
			VE5.remove();
		},
		buttons: {
			'Trigger Event': function () {
				const Event = prompt('Name of event');
				const PL = {
					event: Event,
					timestamp: dayjs().unix(),
					sensorId: 'LIVE-VIEW-EVENT'
				};

				$.ajax({
					type: 'POST',
					url: `/event/${ID}`,
					data: JSON.stringify(PL),
					contentType: 'application/json; charset=utf-8',
					success: function () {
						//
					},
					error: function () {
						alert('Could not create event');
					}
				});
			},
			'Full Screen': function () {
				goFullscreen(VE5);
			},

			Snapshot: function () {
				const canvas = document.createElement('canvas');
				canvas.width = VE5.videoWidth;
				canvas.height = VE5.videoHeight;
				const ctx = canvas.getContext('2d');
				ctx.drawImage(VE5, 0, 0, canvas.width, canvas.height);
				Canvas2Image.saveAsJPEG(canvas);
				canvas.remove();
			}
		}
	});

	if (!MediaSource.isTypeSupported(Codec)) {
		alert('Unsupported mime type');
		return;
	}

	const mediaSource = new MediaSource();
	const DataURL = URL.createObjectURL(mediaSource);
	VE5.src = DataURL;

	mediaSource.addEventListener('sourceopen', function (e) {
		buffer = mediaSource.addSourceBuffer(Codec);
		buffer.mode = 'sequence';
		buffer.addEventListener('updateend', function (e) {
			if (
				mediaSource.duration !== Number.POSITIVE_INFINITY &&
				VE5.currentTime === 0 &&
				mediaSource.duration > 0
			) {
				VE5.currentTime = mediaSource.duration - 1;
				mediaSource.duration = Number.POSITIVE_INFINITY;
			}

			VE5.play();
		});

		socket = io('/', { path: '/streams/' + ID });
		socket.on('segment', function (data) {
			data = new Uint8Array(data);
			buffer.appendBuffer(data);
		});
	});
}

function goFullscreen(element) {
	if (element.mozRequestFullScreen) {
		element.mozRequestFullScreen();
	} else if (element.webkitRequestFullScreen) {
		element.webkitRequestFullScreen();
	}
}

function Login() {
	const Data = {
		password: $('#Password').val(),
		username: $('#Username').val()
	};
	$.ajax({
		type: 'POST',
		url: '/login',
		data: JSON.stringify(Data),
		contentType: 'application/json; charset=utf-8',
		success: function () {
			document.location = '/dashboard';
		},
		error: function () {
			alert('Could not login. This may be due to incorrect login details');
		}
	});
}
