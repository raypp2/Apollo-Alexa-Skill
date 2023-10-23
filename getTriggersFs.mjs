import fs from 'fs';

/* 

#### Device Catalog

endpointID          The unique key ID for Alexa
friendlyName        Alexa's response name unless changed in the Alexa app
displayCategories   Determines the icon and placement of your device in the Alexa app
                    [LIGHT,SWITCH,SMARTPLUG] ...
                    [TV,MUSIC_SYSTEM] ...
                    [ACTIVITY_TRIGGER,SCENE_TRIGGER]...
                    [DOOR,SMARTLOCK,CHRISTMAS_TREE,AIR_CONDITIONER]
dimmable            [True/False] Toggle for lighting
deviceAPI           Identifies the device API to use for Apollo (not used by Alexa)
param               Identifies the parameter for the API

isDimmable:         [TRUE / FALSE] For dimmable lights
isLock:             [TRUE / FALSE] For locks
isSpeaker:          [TRUE / FALSE] For volume adjustable devices ---- NOT IMPLIMENTED
isAC                [TRUE / FALSE] For air conditioners ---- NOT IMPLIMENTED

*/ 


function getTriggers() {
    let triggers = [];
    try {
        triggers = JSON.parse(fs.readFileSync('triggers.json', 'utf8'));
    } catch (err) {
        console.error('Error reading the triggers file.', err);
    }
    return triggers;
}

export { getTriggers };