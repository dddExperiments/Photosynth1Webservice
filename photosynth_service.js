"use strict";

var qs        = require('querystring');
var Guid      = require('guid');
var http      = require('http');
var fs        = require('fs');
var path      = require('path');
var fs_extra  = require('fs-extra');
var zipFolder = require('./zip-folder');
var unzip     = require('unzip');
var he        = require('he');
var DOMParser = require('xmldom').DOMParser;

var _port = 80;
var _upload_url = "/photosynthws/upload.ashx";
var _processing_synth = false; // only support one synth at a time.
var _guid = Guid.EMPTY;
var _output_folder = "output";
var _image_mapping = {};
var _image_counter = 0;
var _name = "";

function CreateSoapResponseBody(soap_body) {
	var body = '';
	body += '<?xml version="1.0" encoding="utf-8"?>';
	body += '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">';
	body += '<soap:Body>';
	body += soap_body;
	body += '</soap:Body>';
	body += '</soap:Envelope>';
	
	return body;
}

function GetServerInfoResponse() {
	var body = '';
	body += '<GetServerInfoResponse xmlns="http://labs.live.com/">';
	body += '<GetServerInfoResult>';
	body += '<Result>OK</Result>';
	body += '<MaxUploadSize>40</MaxUploadSize>';
	body += '<RecommendUploadSize>30</RecommendUploadSize>';
	body += '<SyntherDownloadUrl></SyntherDownloadUrl>'; //http://cdn1.ps1.photosynth.net/installer/2014-08-07/PhotosynthUpgrade.exe
	body += '</GetServerInfoResult>';
	body += '</GetServerInfoResponse>';
	
	return CreateSoapResponseBody(body);
}

function GetUserStatusResponse() {
	var body = '';
	body += '<GetUserStatusResponse xmlns="http://labs.live.com/">';
	body += '<GetUserStatusResult>OK</GetUserStatusResult>';
	body += '<UserStatus>OK</UserStatus>';
	body += '<StorageQuota>21474836480</StorageQuota>';
	body += '<StorageConsumption>0</StorageConsumption>';
	body += '</GetUserStatusResponse>';
	
	return CreateSoapResponseBody(body);
}

function CreateSynthResponse(guid, enabled) {
	var body = '';
	body += '<CreateSynthResponse xmlns="http://labs.live.com/">';
	body += '<CreateSynthResult>';
	body += '<Result>' + (enabled ? 'OK' : 'UploadsAreDisabled') + '</Result>';
	body += '<CollectionId>' + guid + '</CollectionId>';
	body += '<UploadUrl>http://photosynth.net/photosynthws/upload.ashx</UploadUrl>';
	body += '</CreateSynthResult>';
	body += '</CreateSynthResponse>';
	
	return CreateSoapResponseBody(body);
}

function AddSynthPhotoResponse(image_guid) {
	var body = '';
	body += '<AddSynthPhotoResponse xmlns="http://labs.live.com/">';
	body += '<AddSynthPhotoResult>';
	body += '<Result>OK</Result>';
	body += '<PhotoUrl>http://photosynth.net/image/' + image_guid + '.dzi</PhotoUrl>'; //m01001200-BgsN4v_AgSM
	body += '<Action>SEND</Action>'; // SEND - NOSEND
	body += '</AddSynthPhotoResult>';
	body += '</AddSynthPhotoResponse>';	
	
	return CreateSoapResponseBody(body);
}

function CancelSynthResponse() {
	var body = '';
	body += '<CancelSynthResponse xmlns="http://labs.live.com/">';
	body += '<CancelSynthResult>OK</CancelSynthResult>';
	body += '</CancelSynthResponse>';
	
	return CreateSoapResponseBody(body);
}

function CommitSynthResponse(guid, success) {
	var body = '';
	body += '<CommitSynthResponse xmlns="http://labs.live.com/">';
	body += '<CommitSynthResult>';
	body += '<Result>' + (success ? 'OK' : 'UploadsAreDisabled') + '</Result>'; // ???
	body += '<Url>http://photosynth.net/view/' + guid + '</Url>';
	body += '</CommitSynthResult>';
	body += '</CommitSynthResponse>';

	return CreateSoapResponseBody(body);
}

function GetPropertiesFileBody(name, guid, manifest) {
	var dom = new DOMParser();
	var doc = dom.parseFromString(manifest, "application/xml");

	var files = doc.getElementsByTagName("file");
	var num_images = files.length - 2; // minus one for collection and one for point cloud.
	
	var d = new Date();	
	var current_date = "\/Date("+d.getTime()+"+"+d.getTimezoneOffset()+")\/";
	
	var obj = {};
	obj.Id = guid;
	obj.Status = "Available";
	obj.Synth = {
		SynthinessScore: parseFloat(doc.getElementsByTagName("score")[0].getAttribute("value"))
	}
	obj.Name = name;
	obj.Description = doc.getElementsByTagName("description")[0].getAttribute("value");
	obj.CollectionUrl = "https://cdn4.ps1.photosynth.net/synth/"+guid+"/metadata.dzc";
	obj.ThumbnailUrl = "https://cdn4.ps1.photosynth.net/synth/"+guid+"/metadata.synth_files/thumb.jpg";
	obj.ViewUrl = "https://photosynth.net/view/" + guid;
	obj.EditUrl = "https://photosynth.net/edit/" + guid;
	obj.PrivacyLevel = "Public"; // I'm not respecting the one in the manifest.
	obj.SourceApplication = "Synther";
	//obj.GeoTag
	//obj.MapZoomLevel
	obj.UploadDate = current_date;
	obj.CapturedDate = current_date;
	obj.ModifiedDate = current_date;
	obj.ImageCount = num_images;
	obj.OwnerUsername = "Unknown"; // Maybe get from GetUserStatus?
	obj.Viewings = 0;
	obj.FavoriteCount = 0;
	obj.CommentCount = 0;
	obj.Rank = 0;
	obj.HasPaidTag = false;
	obj.Committed = true;

	return JSON.stringify(obj);
}

function GetSoapFileBody(guid) {
	var body = '';
	body += '<GetCollectionDataResponse xmlns="http://labs.live.com/">';
	body += '<GetCollectionDataResult>';
	body += '<Result>OK</Result>';
	body += '<CollectionType>Synth</CollectionType>';
	body += '<DzcUrl>http://cdn4.ps1.photosynth.net/synth/'+guid+'/metadata.dzc</DzcUrl>';
	body += '<JsonUrl>http://cdn4.ps1.photosynth.net/synth/'+guid+'/metadata.synth_files/0.json</JsonUrl>';
	body += '<CollectionRoot>http://cdn4.ps1.photosynth.net/synth/'+guid+'/metadata.synth_files/</CollectionRoot>';
	body += '<PrivacyLevel>Public</PrivacyLevel>';
	body += '</GetCollectionDataResult>';
	body += '</GetCollectionDataResponse>';

	return CreateSoapResponseBody(body);
}

function ParseSoapQuery(body) {
	if (body.indexOf("<GetServerInfo") != -1) {
		return "GetServerInfo";
	} else if (body.indexOf("<GetUserStatus") != -1) {
		return "GetUserStatus";
	} else if (body.indexOf("<CreateSynth") != -1) {
		return "CreateSynth";
	} else if (body.indexOf("<AddSynthPhoto") != -1) {
		return "AddSynthPhoto";
	} else if (body.indexOf("<CommitSynth") != -1) {
		return "CommitSynth";		
	} else if (body.indexOf("<CancelSynth") != -1) {
		return "CancelSynth";
	} else if (body.indexOf("<GetCollectionStatus") != -1) {
		return "GetCollectionStatus";
	} else if (body.indexOf("<IsClientUpdateRequired") != -1) {
		return "IsClientUpdateRequired";
	} else if (body.indexOf("<Ping") != -1) {
		return "Ping";
	} else if (body.indexOf("<ReportUploadStatus") != -1) {
		return "ReportUploadStatus";
	} else {
		return "Unknown";
	}
}

function GetImageHash(body) {
	return body.split("<ImageHash>")[1].split("</ImageHash>")[0];
}

function GetName(body) {
	return body.split("<Name>")[1].split("</Name>")[0];
}

function GetManifest(body) {
	return he.decode(body.split("<Manifest>")[1].split("</Manifest>")[0]);
}

function handleRequest(request, response) {
	if (request.method == 'POST') {
        var chunks = [];
        request.on('data', function (chunk) {
            chunks.push(chunk);
        });
        request.on('end', function () {
			if (request.url == "/photosynthws/PhotosynthService.asmx") {
				var body = chunks.join('');
				var action = ParseSoapQuery(body);
				if (action == "GetServerInfo") {
					response.writeHead(200, {'Content-Type': 'text/html'});
					response.end(GetServerInfoResponse());
				} else if (action == "GetUserStatus") {
					response.writeHead(200, {'Content-Type': 'text/html'});
					response.end(GetUserStatusResponse());
				} else if (action == "CreateSynth") {
					response.writeHead(200, {'Content-Type': 'text/html'});
					if (_processing_synth) {
						// This service only support one synth at a time, returning that uploads are disabled.
						response.end(CreateSynthResponse(_guid, false));
					} else {
						_processing_synth = true;
						_image_counter = 0;
						_image_mapping = {};
						_guid = Guid.raw();
						_name = GetName(body);
						fs_extra.mkdirsSync(path.join(_output_folder, _guid, 'images'));
						fs_extra.mkdirsSync(path.join(_output_folder, _guid, 'points'));
						fs_extra.mkdirsSync(path.join(_output_folder, _guid, 'collection'));
						console.log("Synth " + _guid + " created.");
						response.end(CreateSynthResponse(_guid, true));
					}
				} else if (action == "AddSynthPhoto") {
					response.writeHead(200, {'Content-Type': 'text/html'});
					var image_hash = GetImageHash(body);
					var image_guid = Guid.raw();
					_image_mapping[image_hash] = {guid: image_guid, index: _image_counter};
					response.end(AddSynthPhotoResponse(image_guid));
				} else if (action == "CommitSynth") {
					// Writing properties.json
					fs.writeFile(path.join(_output_folder, _guid, "properties.json"), GetPropertiesFileBody(_name, _guid, GetManifest(body)), function(err) {
						
						// Writing soap.xml
						fs.writeFile(path.join(_output_folder, _guid, "soap.xml"), GetSoapFileBody(_guid), function(err) {
							zipFolder(path.join(_output_folder, _guid), path.join(_output_folder, _guid + ".zip"), function(err) {
								if (err) {
									response.writeHead(200, {'Content-Type': 'text/html'});
									response.end(CommitSynthResponse(_guid, false));
									_processing_synth = false;
								} else {
									fs_extra.removeSync(path.join(_output_folder, _guid));
									response.writeHead(200, {'Content-Type': 'text/html'});
									response.end(CommitSynthResponse(_guid, true));
									_processing_synth = false;
								}
							});
						});
					});
				} else {
					response.writeHead(404, {'Content-Type': 'text/html'});
					response.end('Not found');
				}
			} else if (request.url.indexOf(_upload_url) != -1) {
				if (request.url.indexOf("t=synth.bin") != -1) {
					var file_content = Buffer.concat(chunks);
					var unzip_folder = path.join(_output_folder, _guid);
					var zip_filepath = path.join(_output_folder, _guid, "synth.bin.zip");
					fs.writeFile(zip_filepath, file_content, function(err) {
						fs.createReadStream(zip_filepath).pipe(unzip.Extract({path: unzip_folder})).on('close', function() {
							fs_extra.removeSync(zip_filepath);
							fs_extra.removeSync(path.join(_output_folder, _guid, ".root"));
							fs_extra.walk(path.join(_output_folder, _guid)).on('data', function (item) {
								// move points.bin files to points folder.
								if (item.path.indexOf("points_") != -1) {
									fs.renameSync(item.path, path.join(_output_folder, _guid, 'points', path.basename(item.path)));
								}
							  }).on('end', function () {
								response.writeHead(200, {'Content-Type': 'text/html'});
								response.end('OK');
							  });
						});
					});
					
					
				} else if (request.url.indexOf("t=dzc") != -1) {
					var file_content = Buffer.concat(chunks);
					var unzip_folder = path.join(_output_folder, _guid, "collection");
					var zip_filepath = path.join(_output_folder, _guid, "collection.zip");
					fs.writeFile(zip_filepath, file_content, function(err) {
						fs.createReadStream(zip_filepath).pipe(unzip.Extract({path: unzip_folder})).on('close', function() {
							fs_extra.removeSync(zip_filepath);
							fs_extra.renameSync(path.join(unzip_folder, ".root"), path.join(unzip_folder, "metadata.dsc"));
							response.writeHead(200, {'Content-Type': 'text/html'});
							response.end('OK');
						});
					});
				} else {
					var image_hash = qs.parse(request.url).fid;
					var image_guid = _image_mapping[image_hash].guid;
					var file_content = Buffer.concat(chunks);
					var unzip_folder = path.join(_output_folder, _guid, 'images', image_guid);
					var zip_filepath = path.join(_output_folder, _guid, "images", image_guid + ".zip");
					fs_extra.mkdirsSync(unzip_folder);
					fs.writeFile(zip_filepath, file_content, function(err) {
						fs.createReadStream(zip_filepath).pipe(unzip.Extract({path: unzip_folder})).on('close', function() {
							fs_extra.removeSync(zip_filepath);
							fs_extra.renameSync(path.join(unzip_folder, ".root"), path.join(unzip_folder, "0.dzi"));
							response.writeHead(200, {'Content-Type': 'text/html'});
							response.end('OK');
						});
					});
				}
			} else {
				console.log('POST ' + request.url + " NOT intercepted.");
				response.writeHead(404, {'Content-Type': 'text/html'});
				response.end('Not found');
			}
        });
    } else if (request.method == 'GET') {
		if (request.url.indexOf('/edit/' + _guid) != -1) {
			response.writeHead(200, {'Content-Type': 'text/html'});
			response.end('<h3>Your synth ' + _guid + ' has been exported as a zip file.</h3>');
		} else if (request.url == "/favicon.ico") {
			response.writeHead(200, {'Content-Type': 'image/x-icon'});
			var fileStream = fs.createReadStream('favicon.ico');
			fileStream.pipe(response);
		} else {
			console.log('GET ' + request.url + " NOT intercepted");
			response.writeHead(404, {'Content-Type': 'text/html'});
			response.end('Not found');
		}
	} else {
		console.log(request.method + ' ' + request.url + " NOT intercepted");
		response.writeHead(404, {'Content-Type': 'text/html'});
		response.end('Not found');
	}
}

http.createServer(handleRequest).listen(_port);
console.log('Photosynth service started on port ' + _port);
