/*Copyright 2018 Bang & Olufsen A/S
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.*/

// MPD CONTROL FOR BEOCREATE

var express = require('express');
var exec = require("child_process").exec;
var spawn = require("child_process").spawn;
var path = require("path");
var fs = require("fs");
var mpdAPI = require("mpd-api");
var mpdCmd = mpdAPI.mpd;
const util = require('util');
const execPromise = util.promisify(exec);
const dnssd = require("dnssd2"); // for service discovery.

var debug = beo.debug;

var version = require("./package.json").version;


var defaultSettings = {
	coverNames: ["cover", "artwork", "folder", "front", "albumart"],
	mpdSocketPath: "/var/run/mpd/socket"
};
var settings = JSON.parse(JSON.stringify(defaultSettings));

var sources = null;

var mpdEnabled = false;

var client;
var connected = false;

var libraryPath = null;
var cache = {};

beo.bus.on('general', function(event) {
	
	if (event.header == "startup") {
		
		if (beo.extensions.sources &&
			beo.extensions.sources.setSourceOptions &&
			beo.extensions.sources.sourceDeactivated) {
			sources = beo.extensions.sources;
		}
		
		if (beo.extensions.music && beo.extensions.music.registerProvider) beo.extensions.music.registerProvider("mpd");
		
		if (sources) {
			getMPDStatus(function(enabled) {
				sources.setSourceOptions("mpd", {
					enabled: enabled,
					usesHifiberryControl: true,
					transportControls: true,
					backgroundService: true,
					childSources: ["radio", "music"],
					determineChildSource: determineChildSource
				});
				
				sources.setSourceOptions("radio", {
					enabled: enabled,
					transportControls: ["play", "stop"],
					allowChangingTransportControls: false
				});
				
				if (mpdEnabled) {
					connectMPD();
				}
			});
		}
		
		
	}
	
	if (event.header == "activatedExtension") {
		if (event.content.extension == "mpd") {
			beo.bus.emit("ui", {target: "mpd", header: "mpdSettings", content: {mpdEnabled: mpdEnabled}});
			listStorage().then(storage => {
				beo.sendToUI("mpd", "mountedStorage", {storage: storage});
			}).catch({
				// Error listing storage.
			});
			listNAS();
		}
	}
});

beo.bus.on('mpd', function(event) {
	
	if (event.header == "settings") {
		if (event.content.settings) {
			settings = Object.assign(settings, event.content.settings);
		}
	}
	
	if (event.header == "mpdEnabled") {
		
		if (event.content.enabled != undefined) {
			setMPDStatus(event.content.enabled, function(newStatus, error) {
				beo.bus.emit("ui", {target: "mpd", header: "mpdSettings", content: {mpdEnabled: newStatus}});
				if (sources) {
					//sources.setSourceOptions("mpd", {enabled: newStatus});
					sources.setSourceOptions("radio", {enabled: newStatus});
				}
				if (newStatus == false) {
					//if (sources) sources.sourceDeactivated("mpd");
					if (sources) sources.sourceDeactivated("radio");
				}
				if (error) {
					beo.bus.emit("ui", {target: "mpd", header: "errorTogglingMPD", content: {}});
				}
			});
		}
	
	}
	
	if (event.header == "list") {
		if (client && event.content) {
			client.api.db.list(event.content.type).then(results => {
				beo.sendToUI("mpd", "list", results);
			})
			.catch(error => {
				console.error(error);
			});
		}
	}
	
	if (event.header == "find") {
		if (client && event.content) {
			client.api.db.find(event.content.filter, "window", "0:1").then(results => {
				beo.sendToUI("mpd", "find", results);
			})
			.catch(error => {
				console.error(error);
			});
		}
	}
	
	if (event.header == "update") {
		force = (event.content && (event.content.force || (event.content.extra && event.content.extra == "covers"))) ? true : false;
		setTimeout(function() {
			updateCache(force);
		}, 1000);
	}
	
	
	if (event.header == "getNASShares") {
		getNASShares(event.content).then(results => {
			beo.sendToUI("mpd", "shares", results);
		}).catch({
			// Error listing shares.
		});
	}
	
	if (event.header == "addNAS") {
		details = JSON.parse(JSON.stringify(cachedNASDetails));
		addNAS(details, event.content.share, event.content.path);
	}
	
	if (event.header == "cancelNASAdd") {
		cachedNASDetails = {};
	}
	
	if (event.header == "removeStorage") {
		if (event.content.id) {
			removeStorage(event.content.id);
		}
	}
	
});


function getMPDStatus(callback) {
	exec("systemctl is-active --quiet mpd.service").on('exit', function(code) {
		if (code == 0) {
			mpdEnabled = true;
			callback(true);
		} else {
			mpdEnabled = false;
			callback(false);
		}
	});
}

function setMPDStatus(enabled, callback) {
	if (enabled) {
		exec("systemctl enable --now mpd.service mpd-mpris.service ympd.service").on('exit', function(code) {
			if (code == 0) {
				mpdEnabled = true;
				if (debug) console.log("MPD enabled.");
				callback(true);
				connectMPD();
			} else {
				mpdEnabled = false;
				callback(false, true);
			}
		});
	} else {
		exec("systemctl disable --now mpd.service mpd-mpris.service ympd.service").on('exit', function(code) {
			mpdEnabled = false;
			if (code == 0) {
				callback(false);
				if (debug) console.log("MPD disabled.");
			} else {
				callback(false, true);
			}
		});
	}
}

function determineChildSource(data) {
	if (data && data.streamUrl) {
		if (data.streamUrl.indexOf("http") == 0) {
			return "radio";
		} else {
			return "music";
		}
	} else {
		return null;
	}
}

firstConnect = true;
async function connectMPD() {
	try {
		client = await mpdAPI.connect({path: settings.mpdSocketPath});
		if (debug >= 2) console.log("Connected to Music Player Daemon.");
		if (firstConnect) {
			try {
				config = await client.api.reflection.config();
				if (config.music_directory) {
					libraryPath = config.music_directory;
					// Create a route for serving album covers (and ONLY album covers):
					beo.expressServer.use('/mpd/covers/', (req, res, next) => {
						if (!req.url.match(/^.*\.(png|jpg|jpeg)/ig)) return res.status(403).end('403 Forbidden');
						next();
					});
					beo.expressServer.use("/mpd/covers/", express.static(libraryPath));
					if (fs.existsSync(libraryPath+"/beo-cache.json")) {
						try {
							cache = JSON.parse(fs.readFileSync(libraryPath+"/beo-cache.json", "utf8"));
						} catch (error) {
							cache = {};
						}
					}
					firstConnect = false;
					updateCache();
				} else {
					console.error("MPD music library path is not available. Can't build a cache.");
				}
			} catch(error) {
				console.error("Couldn't get MPD music library path:", error);
			}
		}
	} catch(error) {
		client = null;
		console.error("Failed to connect to Music Player Daemon:", error);
	}
}


var updatingCache = false;
var startOver = false;
async function updateCache(force = false) {
	if (!client) await connectMPD();
	var startOver = (updatingCache) ? true : false; 
	if (client && !updatingCache) {
		try {
			status = await client.api.status.get();
			stats = await client.api.status.stats();
			if (debug && status.updating_db) console.log("MPD is currently updating its database. Album cache may not be up to date after updating.");
			if (cache.lastUpdate == stats.db_update && !force && debug) console.log("MPD album cache appears to be up to date.");
			if ((!cache.lastUpdate || cache.lastUpdate != stats.db_update) || force) { //  && !status.updating_db
				// Start updating cache.
				updatingCache = true;
				if (beo.extensions.music && beo.extensions.music.setLibraryUpdateStatus) beo.extensions.music.setLibraryUpdateStatus("mpd", true);
				if (debug) console.log("Updating MPD album cache.");
				newCache = {
					data: {},
					lastUpdate: stats.db_update
				};
				createTiny = (beo.extensions["beosound-5"]) ? true : false;
				try {
					mpdAlbums = await client.api.db.list("album", null, "albumartist");
		
					for (artist in mpdAlbums) {
						if (startOver) break;
						newCache.data[mpdAlbums[artist].albumartist] = [];
						if (mpdAlbums[artist].album) {
							for (album in mpdAlbums[artist].album) {
								if (startOver) break;
								// Get a song from the album to get album art and other data.
								try {
									addAlbum = true;
									track = [];
									track = await client.api.db.find('((album == "'+escapeString(mpdAlbums[artist].album[album].album)+'") AND (albumartist == "'+escapeString(mpdAlbums[artist].albumartist)+'"))', 'window', '0:1');
									newAlbum = {
										name: mpdAlbums[artist].album[album].album, 
										artist: mpdAlbums[artist].albumartist, 
										date: null, 
										provider: "mpd",
										img: null
									};
									if (track[0]) {
										if (track[0].date) newAlbum.date = track[0].date.toString().substring(0,4);
										cover = await getCover(track[0].file, createTiny);
										if (cover.error != null) { // Cover fetching had errors, likely due to folder not existing.
											addAlbum = false;
										} else {
											newAlbum.img = cover.img;
											newAlbum.thumbnail = cover.thumbnail;
											newAlbum.tinyThumbnail = cover.tiny;
										}
									}
									if (addAlbum) {
										newCache.data[mpdAlbums[artist].albumartist].push(newAlbum);
										if (debug > 1) console.log("Album '"+mpdAlbums[artist].album[album].album+"' from artist '"+mpdAlbums[artist].albumartist+"' was added to the MPD cache.");
									}
								} catch (error) {
									console.error("Could not fetch data for album at index "+album+" from artist at index "+artist+".", error);
								}
							}
						} else {
							console.error("No album items for artist '"+artist+"'. This is probably an MPD (-API) glitch.");
						}
						newCache.data[mpdAlbums[artist].albumartist].sort(function(a, b) {
							if (a.date && b.date) {
								if (a.date >= b.date) {
									return 1;
								} else if (a.date < b.date) {
									return -1;
								}
							} else {
								return 0;
							}
						});
					}
					if (!startOver) {
						cache = Object.assign({}, newCache);
						fs.writeFileSync(libraryPath+"/beo-cache.json", JSON.stringify(cache));
						if (debug) console.log("MPD album cache update has finished.");
					}
				} catch (error) {
					console.error("Couldn't update MPD album cache:", error);
					if (error.code == "ENOTCONNECTED") client = null;
				}
				updatingCache = false;
				if (!startOver) {
					if ((albumsRequested || artistsRequested) &&
						beo.extensions.music &&
						beo.extensions.music.returnMusic) {
							if (albumsRequested) {
								if (debug) console.log("Sending updated list of albums from MPD.");
								albums = [];
								for (artist in cache.data) {
									albums = albums.concat(cache.data[artist]);
								}
								beo.extensions.music.returnMusic("mpd", "albums", albums, null);
							}
							if (artistsRequested) {
								if (debug) console.log("Sending updated list of artists from MPD.");
								mpdAlbums = await client.api.db.list("album", null, "albumartist");
								artists = [];
								for (artist in mpdAlbums) {
									artists.push({artist: mpdAlbums[artist].albumartist, albumLength: mpdAlbums[artist].album.length, provider: "mpd"})
								}
								beo.extensions.music.returnMusic("mpd", "artists", artists, null);
							}
					}
				} else {
					// Start cache update again.
					if (debug) console.log("Restarting MPD album cache update.");
					startOver = false;
					updateCache(force);
				}
			}
		} catch (error) {
			console.error("Couldn't update MPD album cache:", error);
			if (error.code == "ENOTCONNECTED") client = null;
		}
	}
	if (beo.extensions.music && beo.extensions.music.setLibraryUpdateStatus) beo.extensions.music.setLibraryUpdateStatus("mpd", false);
}

var albumsRequested = false;
var artistsRequested = false;

async function getMusic(type, context, noArt = false) {
	
	if (!client) await connectMPD();
	if (client) {
		switch (type) {
			case "albums":
				
				if (context && context.artist) {
					if (cache.data[context.artist]) {
						return cache.data[context.artist];
					} else {
						return [];
					}
	
				} else {
					albums = [];
					albumsRequested = true;
					for (artist in cache.data) {
						albums = albums.concat(cache.data[artist]);
					}
					return albums;
				}
				break;
			case "album":
				if (context && context.artist && context.album) {
					mpdTracks = [];
					album = {name: context.album, 
							time: 0,
							artist: context.artist, 
							date: null, 
							tracks: [],
							discs: [],
							provider: "mpd"
					};
					try {
						mpdTracks = await client.api.db.find("((album == '"+escapeString(context.album)+"') AND (albumartist == '"+escapeString(context.artist)+"'))", 'sort', 'track');
					} catch (error) {
						if (error.code == "ENOTCONNECTED") client = null;
						console.error("Could not get album from MPD:", error);
					}
					for (track in mpdTracks) {
						if (!album.date && mpdTracks[track].date) album.date = mpdTracks[track].date;
						if (track == 0 && !noArt) {
							cover = await getCover(mpdTracks[track].file);
							if (!cover.error) {
								album.img = cover.img;
								album.thumbnail = cover.thumbnail;
								album.tinyThumbnail = cover.thumbnail;
							}
						}
						trackData = {
							disc: 1,
							path: mpdTracks[track].file,
							number: mpdTracks[track].track,
							artist: mpdTracks[track].artist,
							name: mpdTracks[track].title,
							time: mpdTracks[track].time,
							provider: "mpd"
						}
						album.time += mpdTracks[track].time;
						if (mpdTracks[track].disc) {
							trackData.disc = mpdTracks[track].disc;
						}
						album.tracks.push(trackData);
					}
					// Sort tracks on multi-disc albums.
					album.tracks.sort(function(a, b) {
						if (a.disc && b.disc) {
							if (a.disc >= b.disc) {
								return 1;
							} else if (a.disc < b.disc) {
								return -1;
							}
						} else {
							return 0;
						}
					});
					for (t in album.tracks) {
						album.tracks[t].id = t;
						if (!album.discs[album.tracks[t].disc - 1]) {
							album.discs[album.tracks[t].disc - 1] = [];
						}
						album.discs[album.tracks[t].disc - 1].push(album.tracks[t]);
					}
					return album;
				} else {
					return false;
				}
				break;
			case "artists":
				try {
					artistsRequested = true;
					mpdAlbums = await client.api.db.list("album", null, "albumartist");
					artists = [];
					for (artist in mpdAlbums) {
						artists.push({artist: mpdAlbums[artist].albumartist, albumLength: mpdAlbums[artist].album.length, provider: "mpd"})
					}
					return artists;
				} catch (error) {
					if (error.code == "ENOTCONNECTED") client = null;
					console.error("Could not get artists from MPD:", error);
					return false
				}
				break;
			case "search":
				id = 0;
				trackPaths = [];
				tracks = [];
				artists = [];
				albums = [];
				escapedString = escapeString(context.searchString);
				mpdTracks = [];
				try {
					mpdTracks = await client.api.db.search("(title contains '"+escapedString+"')");
					mpdTracks = mpdTracks.concat(await client.api.db.search("(artist contains '"+escapedString+"')"));
					mpdTracks = mpdTracks.concat(await client.api.db.search("(album contains '"+escapedString+"')"));
					for (track in mpdTracks) {
						if (trackPaths.indexOf(mpdTracks[track].file) == -1) {
							trackPaths.push(mpdTracks[track].file);
							trackData = {
								id: id,
								path: mpdTracks[track].file,
								artist: mpdTracks[track].artist,
								name: mpdTracks[track].title,
								time: mpdTracks[track].time,
								provider: "mpd"
							}
							id++;
							tracks.push(trackData);
							albumFound = false;
							for (a in albums) {
								if (albums[a].artist == mpdTracks[track].albumartist &&
									albums[a].name == mpdTracks[track].album) {
									albumFound = true;
									break;
								}
							}
							if (!albumFound) {
								album = {
									name: mpdTracks[track].album, 
									artist: (mpdTracks[track].albumartist) ? mpdTracks[track].albumartist : mpdTracks[track].artist, 
									date: null, 
									provider: "mpd"
								};
								if (mpdTracks[track].date) album.date = mpdTracks[track].date;
								if (!noArt) {
									cover = await getCover(mpdTracks[track].file);
									if (!cover.error) {
										album.img = cover.img;
										album.thumbnail = cover.thumbnail;
										album.tinyThumbnail = cover.thumbnail;
									}
								}
								albums.push(album);
								
								artistFound = false;
								theArtist = (mpdTracks[track].albumartist) ? mpdTracks[track].albumartist : mpdTracks[track].artist;
								for (ar in artists) {
									if (artists[ar].artist == theArtist) {
										artistFound = true;
										break;
									}
								}
								if (!artistFound) {
									artists.push({artist: theArtist, provider: "mpd"});
								}
							}
						}
					}
					return {tracks: tracks, artists: artists, albums: albums};
				} catch (error) {
					if (error.code == "ENOTCONNECTED") client = null;
					console.error("Could not get search results from MPD:", error);
					return false;
				}
				break;
		}
	} else {
		return false;
	}
}

async function playMusic(index, type, context) {
	if (!client) await connectMPD();
	if (client && 
		index != undefined && 
		type && 
		context) {
		content = await getMusic(type, context, true);
		if (content.tracks) {
			try {
				await client.api.queue.clear();
				queueCommands = [];
				content.tracks.forEach(track => {
					queueCommands.push(client.api.queue.addid(track.path));
				});
				
				newQueue = await Promise.all(queueCommands);
				await client.api.playback.playid(newQueue[index]);
				return true;
			} catch (error) {
				if (error.code == "ENOTCONNECTED") client = null;
				console.error("Could not get start playback with MPD:", error);
				return false;
			}
		} else {
			return false;
		}
	}
}


async function getCover(trackPath, createTiny = false, update = false) {
	// If cover exists on the file system, return its path.
	urlParameters = (update) ? "?variant="+Math.round(Math.random()*100) : "";
	if (libraryPath) {
		albumPath = path.dirname(trackPath);
		
		try {
			files = fs.readdirSync(libraryPath+"/"+albumPath);
			img = null;
			thumbnail = null;
			tiny = null;
			for (file in files) {
				if (path.extname(files[file]).match(/\.(jpg|jpeg|png)$/ig)) {
					// Is image file.
					if (!img && settings.coverNames.indexOf(path.basename(files[file], path.extname(files[file])).toLowerCase()) != -1) {
						img = files[file];
					}
					if (files[file] == "cover-thumb.jpg") thumbnail = "cover-thumb.jpg";
					if (files[file] == "cover-tiny.jpg") tiny = "cover-tiny.jpg";
				}
			}
			if (!tiny && 
				img &&
				createTiny) {
				try {
					if (debug) console.log("Creating tiny album artwork for '"+albumPath+"'...");
					await execPromise("convert \""+libraryPath+"/"+albumPath+"/"+img+"\" -resize 100x100\\> \""+libraryPath+"/"+albumPath+"/cover-tiny.jpg\"");
					tiny = "cover-tiny.jpg";
				} catch (error) {
					console.log("Error creating tiny album cover:", error);
				}
			}
			if (img || thumbnail || tiny) {
				encodedAlbumPath = encodeURIComponent(albumPath).replace(/[!'()*]/g, escape);
				return {error: null, 
						img: ((img) ? "/mpd/covers/"+encodedAlbumPath+"/"+img+urlParameters : null), 
						thumbnail: ((thumbnail) ? "/mpd/covers/"+encodedAlbumPath+"/"+thumbnail+urlParameters : null),
						tiny: ((tiny) ? "/mpd/covers/"+encodedAlbumPath+"/"+tiny+urlParameters : null)
					};
			} else {
				return {error: null};
			}
			
			
		} catch (error) {
			// The track/album probably doesn't exist on the file system.
			console.error(error);
			return {error: 404};
		}
	}
	return {error: 503};
}

async function setAlbumCover(uploadPath, context) {
	cover = null;
	if (!client) await connectMPD();
	if (client && libraryPath) {
		try {
			track = [];
			track = await client.api.db.find('((album == "'+escapeString(context.album)+'") AND (albumartist == "'+escapeString(context.artist)+'"))', 'window', '0:1');
			if (track[0]) {
				albumPath = path.dirname(track[0].file);
				files = fs.readdirSync(libraryPath+"/"+albumPath);
				img = null;
				thumbnail = null;
				tiny = null;
				for (file in files) {
					if (path.extname(files[file]).match(/\.(jpg|jpeg|png)$/ig)) {
						// Delete previous covers.
						if (!img && settings.coverNames.indexOf(path.basename(files[file], path.extname(files[file])).toLowerCase()) != -1) {
							fs.unlinkSync(libraryPath+"/"+albumPath+"/"+files[file]);
						}
						if (files[file] == "cover-thumb.jpg") fs.unlinkSync(libraryPath+"/"+albumPath+"/cover-thumb.jpg");
						if (files[file] == "cover-tiny.jpg") fs.unlinkSync(libraryPath+"/"+albumPath+"/cover-tiny.jpg");
					}
				}
				fileExtension = (context.fileType == "image/jpeg") ? ".jpg" : ".png";
				fs.copyFileSync(uploadPath, libraryPath+"/"+albumPath+"/cover"+fileExtension);
				
				// Update the cache to include the new picture.
				createTiny = (beo.extensions["beosound-5"]) ? true : false;
				cover = await getCover(track[0].file, createTiny, true);
				
				if (!cover.error &&
					cache.data[context.artist]) {
					cacheUpdated = false;
					for (a in cache.data[context.artist]) {
						if (cache.data[context.artist][a].name == context.album) {
							cache.data[context.artist][a].img = cover.img;
							cache.data[context.artist][a].thumbnail = cover.thumbnail;
							cache.data[context.artist][a].tinyThumbnail = cover.tiny;
							cacheUpdated = true;
							break;
						}
					}
					if (cacheUpdated) {
						fs.writeFileSync(libraryPath+"/beo-cache.json", JSON.stringify(cache));
						if (debug) console.log("Updated MPD album cache with the new picture.");
					}
				}
				
			}
		} catch (error) {
			console.error("Could not fetch data for album at index "+album+" from artist at index "+artist+".", error);
		}
	}
	fs.unlink(uploadPath, (err) => {
		if (err) console.error("Error deleting file:", err);
	});
	return cover;
}



function escapeString(string) {
	return string.replace(/'/g, "\\\\'").replace(/"/g, '\\\\"').replace(/\\/g, '\\');
}


var storageList = [];
var listingStorage = false;
async function listStorage() {
	if (!listingStorage) {
		listingStorage = true;
		storage = [];
		// List mounted USB storage.
		try {
			storageUSB = await execPromise("mount | awk '/dev/sd && "+libraryPath+"'");
			storageUSB = storageUSB.stdout.trim().split("\n");
			for (s in storageUSB) {
				device = {id: storageUSB[s].split(" on ")[0], mount: storageUSB[s].split(" on ")[1].split(" type ")[0], kind: "USB"};
				label = await execPromise("blkid "+device.id+" -o value -s LABEL");
				device.name = label.stdout.trim();
				storage.push(device);
			}
		} catch (error) {
			console.error("Couldn't get a list of USB storage:", error);
		}
		
		// List configured NAS destinations.
		try {
			storageNAS = fs.readFileSync("/etc/smbmounts.conf", "utf8").split('\n');
			for (s in storageNAS) {
				slash = (storageNAS[s].indexOf("//") != -1) ? "/" : "\\"; // Does this line use forward or backslashes?
				nasItem = storageNAS[s].trim().split(";");
				if (nasItem[0].charAt(0) != "#") { // Not a comment.
					nasAddress = nasItem[1].substr(2).split(slash)[0];
					nasName = nasAddress;
					for (n in discoveredNAS) {
						if ((discoveredNAS[n].netbios && 
							nasAddress == discoveredNAS[n].netbios) ||
							discoveredNAS[n].addresses[0].indexOf(nasAddress) != -1) {
							nasName = discoveredNAS[n].name;
						}
					}
					try {
						nasMountRaw = await execPromise("mount | grep '"+nasItem[0]+"'");
						if (nasMountRaw.stdout) {
							nasMount = nasMountRaw.stdout.trim().split(" on ")[1].split(" type ")[0];
						} else {
							console.error("NAS '"+nasItem[0]+"' does not appear to be mounted.");
							nasMount = false;
						}
					} catch (error) {
						console.error("NAS '"+nasItem[0]+"' does not appear to be mounted.");
						nasMount = false;
					}
					storage.push({
						kind: "NAS",
						id: nasItem[0], 
						name: nasName,
						address: nasAddress,
						path: nasItem[1].substr(2).split(slash).slice(1).join("/"),
						mount: nasMount
					});
				}
			}
		} catch (error) {
			console.log("Couldn't get a list of configured NAS storage:", error);
		}
		
		storageList = storage;
		listingStorage = false;
	}
	return storageList;
}

async function removeStorage(id) {
	storageList = await listStorage();
	errors = 0;
	for (s in storageList) {
		if (storageList[s].id == id) {
			// The correct storage was found.
			if (storageList[s].mount) {
				try {
					await execPromise("umount "+storageList[s].mount);
				} catch (error) {
					console.error("Unable to eject '"+storageList[s].mount+"':", error);
					errors = 1;
				}
			} else {
				console.error("Storage device '"+storageList[s].id+"' is not mounted.");
			}
			if (storageList[s].kind == "NAS") { // Remove from configured NAS storage.
				try {
					nasIndex = -1;
					storageNAS = fs.readFileSync("/etc/smbmounts.conf", "utf8").split('\n');
					for (s in storageNAS) {
						nasItem = storageNAS[s].trim().split(";");
						if (nasItem[0].charAt(0) != "#") { // Not a comment.
							if (nasItem[0] == id) {
								nasIndex = s;
								break;
							}
						}
					}
					if (nasIndex != -1) {
						storageNAS.splice(nasIndex, 1);
						fs.writeFileSync("/etc/smbmounts.conf", storageNAS.join("\n"));
					}
				} catch (error) {
					console.error("Unable to remove NAS '"+storageList[s].id+"' from configuration:", error);
				}
			}
			break;
		}
	}
	if (errors == 0 && debug) console.log("Storage device '"+storageList[s].id+"' was ejected.");
	storage = await listStorage();
	beo.sendToUI("mpd", "mountedStorage", {storage: storage, unmountErrors: errors});
	try {
		if (debug) console.log("Triggering MPD database update.");
		execPromise("/opt/hifiberry/bin/update-mpd-db");
	} catch (error) {
		console.error("Error triggering MPD database update:", error);
	}
}


// Discover NAS storage.

var browser = null;
var discoveryStopDelay = null;
var discoveredNAS = {};

function startDiscovery() {

	beo.sendToUI("mpd", "discoveredNAS", {storage: {}});
	if (!browser) {
		browser = new dnssd.Browser(dnssd.tcp('smb'));
		
		browser.on('serviceUp', service => discoveryEvent("up", service));
		browser.on('serviceDown', service => discoveryEvent("down", service));
		browser.on('serviceChanged', service => discoveryEvent("changed", service));
		browser.on('error', error => console.log("dnssd error: ", error));
	} else {
		browser.stop();
	}
	
	browser.start();
	clearTimeout(discoveryStopDelay);
	discoveryStopDelay = setTimeout(function() {
		stopDiscovery();
	}, 60000);
}

function stopDiscovery() {
	if (browser) browser.stop();
}

var listingNAS = false;
async function listNAS() {
	if (!listingNAS) {
		if (debug) console.log("Looking for NAS devices with SMB protocol...");
		listingNAS = true;
		discoveredNAS = {};
		netbiosLookupRaw = null;
		namesUpdated = false;
		try {
			netbiosLookupRaw = await execPromise("/opt/hifiberry/bin/list-smb-servers");
		} catch (error) {
			console.error("Error performing a NetBIOS lookup:", error);
		}	
		if (netbiosLookupRaw && netbiosLookupRaw.stdout) {
			netbiosItems = netbiosLookupRaw.stdout.trim().split("\n");
			for (n in netbiosItems) {
				netbios = netbiosItems[n].split(", ");
				netbiosIP = netbios[1].split(" ")[0].trim();
				netbiosName = netbios[0].trim();
		
				if (!discoveredNAS[netbiosName]) {
					discoveredNAS[netbiosName] = {name: netbiosName, netbios: netbiosName, from: "netbios", addresses: [netbiosIP]};
				}
				
				for (s in storageList) {
					if (storageList[s].kind == "NAS") {
						if ((storageList[s].address == discoveredNAS[netbiosName].addresses[0] || discoveredNAS[netbiosName].netbios.indexOf(storageList[s].name) != -1) &&
							storageList[s].name != discoveredNAS[netbiosName].name) {
							storageList[s].name = discoveredNAS[netbiosName].name;
							namesUpdated = true;
						}
					}
				}
			}
		}
		if (namesUpdated) beo.sendToUI("mpd", "mountedStorage", {storage: storageList});
		beo.sendToUI("mpd", "discoveredNAS", {storage: discoveredNAS});
		startDiscovery();
		listingNAS = false;
	}
}

async function discoveryEvent(event, service) {
	if (event == "up" || event == "changed") {
		if (!discoveredNAS[service.name]) discoveredNAS[service.name] = {};
		discoveredNAS[service.name].name = service.name;
		discoveredNAS[service.name].from = "bonjour";
		discoveredNAS[service.name].hostname = service.host; 
		discoveredNAS[service.name].addresses = service.addresses;
		
		discoveredNAS[service.name].addresses.sort(function(a, b) {
			if (a.length >= b.length) {
				return 1;
			} else {
				return -1;
			}
		});
		
		if (discoveredNAS[service.name].addresses[0].indexOf(":") != -1) { // We just have an IPv6 address, see if we can get it in IPv4.
			try {
				avahiRaw = await execPromise("avahi-resolve-host-name \""+service.host+"\"");
				address = avahiRaw.stdout.trim().split("\t")[1];
				if (address.indexOf(".") != -1) {
					discoveredNAS[service.name].addresses.unshift(address.trim());
				}
			} catch (error) {
				
			}
		}
		var namesUpdated = false;
		
		for (n in discoveredNAS) {
			if (discoveredNAS[n].from == "netbios" &&
				discoveredNAS[n].addresses[0] == service.addresses[0]) {
				discoveredNAS[service.name].netbios = discoveredNAS[n].netbios;
				delete discoveredNAS[n];
			}
		}
		
		if (!discoveredNAS[service.name].netbios && discoveredNAS[service.name].addresses[0].indexOf(".") != -1) {
			try {
				// This entry has no Netbios name, so try to look it up.
				netbiosRaw = await execPromise("nmblookup -A "+discoveredNAS[service.name].addresses[0]+" | grep '<20>' | awk '{print $1}'");
				discoveredNAS[service.name].netbios = netbiosRaw.stdout.trim();
			} catch (error) {
				console.error("Error getting NetBIOS name for '"+service.name+"':", error);
			}
		}
		
		for (s in storageList) {
			if (storageList[s].kind == "NAS") {
				if (((discoveredNAS[service.name].netbios &&
					discoveredNAS[service.name].netbios.indexOf(storageList[s].name) != -1) || (
					discoveredNAS[service.name].hostname && 
					discoveredNAS[service.name].hostname.indexOf(storageList[s].name) != -1)) &&
					storageList[s].name != service.name) {
					storageList[s].name = service.name;
					namesUpdated = true;
				}
			}
		}
		if (namesUpdated) beo.sendToUI("mpd", "mountedStorage", {storage: storageList});
	} else if (event == "down") {
		delete discoveredNAS[service.name];
	}
	beo.sendToUI("mpd", "discoveredNAS", {storage: discoveredNAS});
}

var cachedNASDetails = {};
async function getNASShares(details) {
	shareList = [];
	errors = false;
	if (details.server && details.username && details.password != undefined) {
		if (details.server.addresses[0].indexOf(".") == -1) { // Probably an IPv6 address, try to get it in IPv4.
			//address = await dnssd.resolveA(details.server.hostname);
			address = details.server.addresses[0];
		} else {
			address = details.server.addresses[0];
		}
		try {
			if (!details.server.netbios) {
				try {
					netbiosRaw = await execPromise("nmblookup -A "+details.server.addresses[0]+" | grep '<20>' | awk '{print $1}'");
					details.server.netbios = netbiosRaw.stdout.trim();
				} catch (error) {
					details.server.netbios = null;
				}
			}
			if (details.server.netbios) {
				address = details.server.netbios;
			} else {
				address = details.server.addresses[0];
			}
			sharesRaw = await execPromise("smbclient -N -L "+address+" --user="+details.username+"%"+details.password+" -g | grep 'Disk|'");
			sharesRaw = sharesRaw.stdout.trim().split("\n");
			for (s in sharesRaw) {
				shareList.push(sharesRaw[s].slice(5, -1));
			}
		} catch (error) {
			console.error("Couldn't get a list of SMB shares:", error);
			errors = true;
		}
		cachedNASDetails = details;
	}
	return {server: details.server, shares: shareList, errors: errors};
}

async function addNAS(details, share, path) {
	storageNAS = fs.readFileSync("/etc/smbmounts.conf", "utf8").split('\n');
	beo.sendToUI("mpd", "addingNAS");
	if (details.server.from == "bonjour") {
		address = details.server.hostname.replace(".local.", ".local");
	} else if (details.server.netbios) {
		address = details.server.netbios;
	} else {
		address = details.server.addresses[0];
	}
	storageNAS.push(details.server.name+"-"+share+"-"+makeID(5)+";//"+address+"/"+share+path+";"+details.username+";"+details.password);
	fs.writeFileSync("/etc/smbmounts.conf", storageNAS.join("\n"));
	if (debug) console.log("Added '"+share+path+"' from NAS '"+details.server.name+"'.");
	cachedNASDetails = {};
	await mountNewNAS();
	try {
		storage = await listStorage();
		beo.sendToUI("mpd", "mountedStorage", {storage: storage});
	} catch (error) {
		console.error("Error listing storage:", error);
	}
	listNAS();
	beo.sendToUI("mpd", "addedNAS", {name: details.server.name});
}

function makeID(length) { // From https://stackoverflow.com/questions/1349404/generate-random-string-characters-in-javascript
	var result = '';
	var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	var charactersLength = characters.length;
	for (var i = 0; i < length; i++) {
		result += characters.charAt(Math.floor(Math.random() * charactersLength));
	}
	return result;
}

var mountInProgress = 0;
async function mountNewNASOld(override = false) {
	//if (!override) mountInProgress++;
	//if (!mountInProgress || override) {
	if (debug) console.log("Mounting new NAS storage...");
		try {
			await execPromise("/opt/hifiberry/bin/mount-smb.sh");
			if (debug) console.log("NAS storage mount finished.");
			return true;
			//mountInProgress--;
		} catch (error) {
			//mountInProgress--;
			console.error("Error running NAS/SMB mount program:", error);
			return false;
		}
	/*	if (mountInProgress) {
			mountNewNAS(true);
		}
	}*/
}

function mountNewNAS() {
	return new Promise(function(resolve, reject) {
		
		mountProcess = spawn("/opt/hifiberry/bin/mount-smb.sh", {
			detached: true
		});
		
		mountProcess.stdout.on('data', function (data) {
			//console.log('stdout: ' + data.toString());
			data = data.toString();
			if (data.indexOf("Updating DB (")) {
				mountProcess.unref();
				setTimeout(function() {
					if (debug) console.log("NAS storage mount finished.");
					resolve(true);	
				}, 1000);
			}
		});
		
		mountProcess.on('exit', function (code) {
			resolve(true);
		});
	});
}

	
module.exports = {
	version: version,
	isEnabled: getMPDStatus,
	getMusic: getMusic,
	playMusic: playMusic,
	setAlbumCover: setAlbumCover
};

