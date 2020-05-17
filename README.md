### Photosynth1 Webservice.

photosynth.net is down thus the web-service used by the ps1 synther is not available anymore.
This node.js service can be used as a replacement.
Instead of saving the ps1 synth to the cloud it will be saved as zip file in the output folder.
And it can then be viewed with the local [offline viewer](https://github.com/dddExperiments/offlineViewer).

### Setup

You need to edit:
```
c:\windows\system32\drivers\etc\hosts
```
and add the following line:
```
127.0.0.2 photosynth.net
```
Note that writing to this file require administrator privilege.

Then as usual, in the folder where you have unzip this github repo, run:
```
npm install
```

### Run

```
node photosynth_service.js
```

Then you can sign in with Microsoft credential when starting ps1 synther and this webservice will intercept
the calls made to original (but now down) service and instead save the synth locally as a zip file.
