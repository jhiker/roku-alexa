var http = require('http');
var fs = require('fs');
var urllib = require("url");
var Client = require('node-ssdp').Client;
var dgram = require('dgram'); 

//null will cause the server to discover the Roku on startup, hard coding a value will allow for faster startups
var rokuAddress = null;
var PORT=1234; 

var ssdp = new Client();

//handle the ssdp response when the roku is found
ssdp.on('response', function (headers, statusCode, rinfo) {
	rokuAddress = headers.LOCATION;
	console.log("Found Roku: ",rokuAddress);
});

//this is called periodically and will only look for the roku if we don't already have an address
function searchForRoku() {
	if (rokuAddress == null) {
		ssdp.search('roku:ecp');
	}
}

//a simple wrapper to post to a url with no payload (to send roku commands)
function post(url,callback) {
	var info = urllib.parse(url);
	console.log("Posting: ",url);
    var opt = {
        host:info.hostname,
		port:info.port,
        path: info.path,
        method: 'POST',
    };

    var req = http.request(opt, callback);

    req.end();
}

//Performing an operation on the roku normally takes a handful of button presses
//This function will perform the list of commands in order and if a numerical value is included in the sequence it will be inserted as a delay
function postSequence(sequence,callback) {
	function handler() {
		if (sequence.length == 0) {
			if (callback) callback();
			return;
		}
		var next = sequence.shift();
		if (typeof next === "number") {
			setTimeout(handler,next);
		} else if (typeof next === "string") {
			post(next,function(res) {
                res.on("data",function() {}); //required for the request to go through without error
                handler();
			});
		}
	}
	handler();
}

//In order to send keyboard input to the roku, we use the keyress/Lit_* endpoint which can be any alphanumeric character
//This function turns a string into a series of these commands with delays of 100ms built in
//NOTE: this currently ignores anything that isn't lowercase alpha
function createTypeSequence(text) {
	var sequence = [];
	for (var i=0; i<text.length; i++) {
		var c = text.charCodeAt(i);
		if (c >= 97 && c <=122) { //alpha only
			sequence.push(rokuAddress+"keypress/Lit_"+text.charAt(i));
			sequence.push(100);
		}
		else if (c === 32) {
			sequence.push(rokuAddress+"keypress/Lit_%20");
			sequence.push(100);
		}
	}
	return sequence;
}

//simple helper function to pull the data out of a post request. This could be avoided by using a more capable library such
function getRequestData(request,callback) {
	var body = "";
	request.on("data",function(data) {
		body += String(data);
	});
	request.on("end",function() {
		callback(body);
	});
}

function parseData(data) {
	//ugly data parse function
	var lines = data.replace(/^\s+|\s+$/g,'').toLowerCase().split('\n');
	for (var i = 0; i < lines.length; i ++) {
		var line = lines[i];
		if (line.trim().length !== 0) {
			if (line.split(':')[0] !== 'content-disposition' && line[0] != '-')
				return line;
		}	
	};
}

//depending on the URL endpoint accessed, we use a different handler.
//This is almost certainly not the optimal way to build a TCP server, but for our simple example, it is more than sufficient
var handlers = {
    //This will play the last searched movie or show, we use it because it consistently resides to the right of the search box
	"/roku/playlast":function(request,response) {
		postSequence([
			rokuAddress+"keypress/home",    //wake the roku up, if its not already
			rokuAddress+"keypress/home",    //go back to the home screen (even if we're in netflix, we need to reset the interface)
			3000,                           //loading the home screen takes a few seconds
			rokuAddress+"launch/12",        //launch the netflix channel (presumably this is always id 12..)
			7000,                           //loading netflix also takes some time
			rokuAddress+"keypress/down",    //the last searched item is always one click down and one click to the right of where the cursor starts
			rokuAddress+"keypress/right",
			1000,                           //more delays, experimentally tweaked.. can probably be significantly reduced by more tweaking
			rokuAddress+"keypress/Select",  //select the show from the main menu
			3000,                           //give the show splash screen time to load up
			rokuAddress+"keypress/Play"     //play the current/next episode (whichever one comes up by default)
		]);
		response.end("OK"); //we provide an OK response before the operation finishes so that our AWS Lambda service doesn't wait around through our delays
	},
    //This endpoint doenst perform any operations, but it allows an easy way for you to dictate typed text without having to use the on screen keyboard
	"/roku/type":function(request,response) {
		getRequestData(request,function(data) {
			var text = parseData(data); //trim whitespace and lowercase
			console.log('parse', text);
			var sequence = createTypeSequence(text);
			postSequence(sequence,function() {

			});
			response.end("OK");	
		});
	},
    //Takes the POST data and uses it to search for a show and then immediate plays that show
	"/roku/searchplay":function(request,response) {
		getRequestData(request,function(data) {
			var text = parseData(data); //trim whitespace and lowercase
			console.log(text);
			var sequence = [].concat([
				rokuAddress+"keypress/home",    //wake roku
				rokuAddress+"keypress/home",    //reset to home screen
				3000,
				rokuAddress+"launch/12",        //launch netflix app
				9000,
				rokuAddress+"keypress/Select",  //select search
				200,
				rokuAddress+"keypress/Select",  //select search
				200,
				rokuAddress+"keypress/Select",  //select search
				200,
				rokuAddress+"keypress/back",    //navigate to search
				300,
				rokuAddress+"keypress/back",    //navigate to search
				300,
				rokuAddress+"keypress/back",    //navigate to search
				300,
				rokuAddress+"keypress/Select",  //select search
				200,
			],createTypeSequence(text),[        //enter the text
				8000,
				rokuAddress+"keypress/right",   //go to search selections (which show up to the right of they keyboard.. we need to tap through them)
				100,
				rokuAddress+"keypress/right",
				100,
				rokuAddress+"keypress/right",
				100,
				rokuAddress+"keypress/right",
				100,
				rokuAddress+"keypress/right",
				100,
				rokuAddress+"keypress/right",
				500,
				rokuAddress+"keypress/Select", //selected the top result and returns to the main screen
				3000,                          //wait for main menu
				rokuAddress+"keypress/right",  //goto searched item
				rokuAddress+"keypress/Select", //drill into show
			]);
			postSequence(sequence);
			response.end("OK");	 //respond with OK before the operation finishes
		});
	},
    //the play and pause buttons are the same and is called "Play"
	"/roku/playpause":function(request,response) {
		post(rokuAddress+"keypress/Play");
		response.end("OK");	
	},
	"/roku/nextepisode":function(request,response) {
		postSequence([
			rokuAddress+"keypress/back",
			1000,
			rokuAddress+"keypress/down",
			100,
			rokuAddress+"keypress/down",
			100,
			rokuAddress+"keypress/select",
			2000,
			rokuAddress+"keypress/right",
			100,
			rokuAddress+"keypress/select",
			1000,
			rokuAddress+"keypress/Play",
		],function() {

		});
		response.end("OK");
	},
	"/roku/lastepisode":function(request,response) {
		postSequence([
			rokuAddress+"keypress/back",
			1000,
			rokuAddress+"keypress/down",
			100,
			rokuAddress+"keypress/down",
			100,
			rokuAddress+"keypress/select",
			2000,
			rokuAddress+"keypress/left",
			100,
			rokuAddress+"keypress/select",
			1000,
			rokuAddress+"keypress/Play",
		],function() {

		});
		response.end("OK");
	},
	"/roku/hbo":function(request,response) {
		postSequence([
			rokuAddress+"keypress/home",
			100,
			rokuAddress+"/launch/8378",
			6000,
		],function() {
			getRequestData(request,function(data) {
				var text = parseData(data); //trim whitespace and lowercase
				console.log(text);
				if (text && text.length) {
					var arr = [];
					for (var i = 0; i < 20; i ++) {
						arr.push(rokuAddress+"keypress/down");
						arr.push(50);
					}
					arr.push(rokuAddress + 'keypress/select');
					arr.push(3000);
					arr = arr.concat(createTypeSequence(text));
					for (var i = 0; i < 15; i ++) {
						arr.push(rokuAddress+"keypress/down");
						arr.push(50);
					}
					arr.push(rokuAddress+"keypress/select");
					arr.push(400);
					arr.push(rokuAddress+"keypress/select");
					arr.push(400);
					arr.push(rokuAddress+"keypress/select");
					postSequence(arr);
				}
			});
			response.end("OK");
			}
		);
	},
	"/roku/youtube":function(request,response) {
		postSequence([
			rokuAddress+"keypress/home",
			100,
			rokuAddress+"/launch/837",
			12000,
		],function() {
			getRequestData(request,function(data) {
				var text = parseData(data); //trim whitespace and lowercase
				console.log(text);
				if (text && text.length) {
					var arr = [];
					for (var i = 0; i < 8; i ++) {
						arr.push(rokuAddress+"keypress/up");
						arr.push(50);
					}
					arr.push(rokuAddress + 'keypress/select');
					arr.push(1000);
					arr = arr.concat(createTypeSequence(text));
					postSequence(arr);
				}
			});
			response.end("OK");
			}
		);
	},

	"/roku/spotify":function(request,response) {
		postSequence([
			rokuAddress+"keypress/home",
			100,
			rokuAddress+"/launch/19977",
			4500,
		],function() {
			getRequestData(request,function(data) {
				var text = parseData(data); //trim whitespace and lowercase
				console.log(text);
				if (text && text.length) {
					var arr = [];
					for (var i = 0; i < 8; i ++) {
						arr.push(rokuAddress+"keypress/up");
						arr.push(50);
					}
					arr.push(rokuAddress + 'keypress/select');
					arr.push(1000);
					arr.push(rokuAddress + 'keypress/select');
					arr = arr.concat(createTypeSequence(text));
					arr.push(1000);
					for (var i = 0; i < 3; i ++) {
						arr.push(rokuAddress+"keypress/right");
						arr.push(50);
					}
					arr.push(rokuAddress+'keypress/select');
					arr.push(rokuAddress+'keypress/select');
					postSequence(arr);
				}
			});
			response.end("OK");
			}
		);
	},


	"/roku/toggletv":function(request,response) {
		postSequence([
			rokuAddress+"keypress/power",
		],function() {

		});
		response.end("OK");
	}

}

//handles and incoming request by calling the appropriate handler based on the URL
function handleRequest(request, response){
	if (handlers[request.url]) {
		handlers[request.url](request,response);
	} else {
		console.log("Unknown request URL: ",request.url);
		response.end();
	}
}
//start the MSEARCH background task to try every second (run it immediately too)
setInterval(searchForRoku,1000);
searchForRoku();

//start the tcp server
http.createServer(handleRequest).listen(PORT,function(){
    console.log("Server listening on: http://localhost:%s", PORT);
});
