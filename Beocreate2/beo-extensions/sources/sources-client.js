var sources = (function() {

allSources = {};
currentSource = null;
focusedSource = null;
sourceOrder = [];

$(document).on("general", function(event, data) {
	if (data.header == "connection") {
		if (data.content.status == "connected") {
			beo.send({target: "sources", header: "getSources"});
		}
	}
	
	if (data.header == "activatedExtension") {
		if (data.content.extension != "sources" && arrangingSources) {
			toggleArrange();
		}
		if (allSources[data.content.extension]) {
			if (allSources[data.content.extension].alias) {
				$("#"+data.content.extension+" .source-alias-control .menu-value").text(allSources[data.content.extension].alias.name).removeClass("button");
			} else {
				$("#"+data.content.extension+" .source-alias-control .menu-value").text("Set...").addClass("button");
			}
		}
	}
	
});

$(document).on("sources", function(event, data) {

	
	if (data.header == "sources") {
		
		if (data.content.sources != undefined) {
			
			allSources = data.content.sources;
			if (data.content.currentSource != undefined) {
				currentSource = data.content.currentSource;
			} else {
				currentSource = null;
			}
			if (data.content.focusedSource != undefined) {
				focusedSource = data.content.focusedSource;
			} else {
				focusedSource = null;
			}
			if (data.content.sourceOrder) {
				sourceOrder = data.content.sourceOrder;
				orderChanged = true;
			} else {
				orderChanged = false;
			}
			showActiveSources();
			updateSourceOrder(orderChanged);
			updateAliases();
		}
	}

	
	if (data.header == "configuringSystem") {
		beo.notify({title: "Setting up sources...", icon: "attention", timeout: false, id: "sources"});
	}
	
	if (data.header == "systemConfigured") {
		beo.notify(false, "sources");
	}
	
	if (data.header == "defaultAliases") {
		if (aliasSource && data.content.aliases) {
			$(".default-aliases").empty();
			for (alias in data.content.aliases) {
				
				$(".default-aliases").append(beo.createMenuItem({
					label: data.content.aliases[alias].name,
					icon: extensions.sources.assetPath+"/symbols-black/"+data.content.aliases[alias].icon,
					onclick: "sources.setAlias('"+aliasSource+"', '"+alias+"', true);"
				}));
			}
			if (allSources[aliasSource].alias) {
				$(".remove-source-alias").removeClass("hidden");
			} else {
				$(".remove-source-alias").addClass("hidden");
			}
			beo.ask("set-source-alias-prompt", [extensions[aliasSource].title], [
				function() {
					defaultText = (allSources[aliasSource].alias) ? allSources[aliasSource].alias.name : extensions[aliasSource].title;
					beo.startTextInput(1, "Set Alias", "Enter the display name for "+extensions[aliasSource].title+".", {placeholders: {text: "Alias"}, text: defaultText}, function(input) {
						if (input && input.text) {
							setAlias(aliasSource, input.text);
						} else {
							aliasSource = null;
						}
					});
				},
				function() {setAlias(aliasSource, null, true)}], function() {
				aliasSource = null;
			});
		}
	}
	
});

function showActiveSources() {
	$(".source-menu-item").addClass("hide-icon-right");
	// Current, playing source.
	if (currentSource != null) {
		sourceIcon = null;
		sourceName = null;
		if (allSources[currentSource].aliasInNowPlaying) {
			sourceName = allSources[currentSource].aliasInNowPlaying;
		} else if (allSources[currentSource].alias) {
			if (allSources[currentSource].alias.icon) {
				sourceIcon = extensions.sources.assetPath+"/symbols-black/"+allSources[currentSource].alias.icon;
			}
			sourceName = allSources[currentSource].alias.name;
		}
		if (!sourceIcon && 
			extensions[currentSource].icon && 
			extensions[currentSource].assetPath) {
				sourceIcon = extensions[currentSource].assetPath+"/symbols-black/"+extensions[currentSource].icon;
		}
		if (!sourceName) sourceName = extensions[currentSource].title;
		if (sourceIcon) {
			beo.setSymbol(".active-source-icon", sourceIcon);
			$(".active-source-icon").removeClass("hidden");
		} else {
			$(".active-source-icon").addClass("hidden");
		}
		$(".active-source-name").text(sourceName);
		$('.source-menu-item[data-extension-id="'+currentSource+'"]').removeClass("hide-icon-right");
		setTimeout(function() {
			$(".active-source").addClass("visible");
		}, 50);
	} else {
		$(".active-source").removeClass("visible");
	}
	
	// Which source is focused.
	if (focusedSource != null) {
		sourceIcon = null;
		sourceName = null;
		if (allSources[focusedSource].aliasInNowPlaying) {
			sourceName = allSources[focusedSource].aliasInNowPlaying;
		} else if (allSources[focusedSource].alias) {
			if (allSources[focusedSource].alias.icon) {
				sourceIcon = extensions.sources.assetPath+"/symbols-black/"+allSources[focusedSource].alias.icon;
			}
			sourceName = allSources[focusedSource].alias.name;
		}
		if (!sourceIcon && 
			extensions[focusedSource].icon && 
			extensions[focusedSource].assetPath) {
				sourceIcon = extensions[focusedSource].assetPath+"/symbols-black/"+extensions[focusedSource].icon;
		}
		if (!sourceName) sourceName = extensions[focusedSource].title;
		if (sourceIcon) {
			beo.setSymbol(".focused-source-icon", sourceIcon);
			$(".focused-source-icon").removeClass("hidden");
		} else {
			$(".focused-source-icon").addClass("hidden");
		}
		$(".focused-source-name").text(sourceName);
		setTimeout(function() {
			$(".focused-source").addClass("visible");
		}, 50);
	} else {
		$(".focused-source:not(.source-select)").removeClass("visible");
		$(".focused-source.source-select .focused-source-name").text("No Source");
		$(".focused-source.source-select .focused-source-icon").addClass("hidden");
	}
}

var previousDisabled = 0;
function updateSourceOrder(force) {
	// Move disabled and enabled sources to their own sections, preserving user order.
		disabledSources = 0;
		for (source in allSources) {
			if (allSources[source].enabled != true) disabledSources++;
		}
		if (previousDisabled != disabledSources || force) {
			for (s in sourceOrder) {
				source = sourceOrder[s];
				if (allSources[source].enabled == true || arrangingSources) {
					if ($('.disabled-sources .menu-item[data-extension-id="'+source+'"]').length > 0) {
						$(".enabled-sources").append($('.disabled-sources .menu-item[data-extension-id="'+source+'"]').detach());
					} else {
						$(".enabled-sources").append($('.enabled-sources .menu-item[data-extension-id="'+source+'"]').detach());
					}
				} else {
					if ($('.enabled-sources .menu-item[data-extension-id="'+source+'"]').length > 0) {
						$(".disabled-sources").append($('.enabled-sources .menu-item[data-extension-id="'+source+'"]').detach());
					} else {
						$(".disabled-sources").append($('.disabled-sources .menu-item[data-extension-id="'+source+'"]').detach());
					}
				}
			}
			previousDisabled = disabledSources;
			if (disabledSources && !arrangingSources) {
				$(".disabled-sources-header").removeClass("hidden");
			} else {
				$(".disabled-sources-header").addClass("hidden");
			}
		}
}

var arrangingSources = false;
var sourceArrangeDrag = null;
var sourcesArranged = false;
function toggleArrange() {
	if (!arrangingSources) {
		arrangingSources = true;
		sourcesArranged = false;
		if (!sourceArrangeDrag) {
			sourceArrangeDrag = new Beodrag(".enabled-sources .menu-item", {
				arrange: true,
				preventClick: true,
				pre: function(event, position, target) {
					target.classList.add("drag"); // When item is held down long enough.
				},
				start: function(event, position, target) {
					target.classList.add("drag");
				},
				move: function(event, position, target) {
					// Move is handled by the internal "arranger" feature in Beodrag.
				},
				end: function(event, position, target, moveFrom = null, moveTo = null, elements) {
					if (moveFrom != null) {
						sourcesArranged = true;
						setTimeout(function() {
							sourceToMove = sourceOrder[moveFrom];
							sourceOrder.splice(moveFrom, 1);
							sourceOrder.splice(moveTo, 0, sourceToMove);
							for (var e = 0; e < elements.length; e++) {
								elements[e].style.transition = "none";
								elements[e].style.transform = null;
								elements[e].style.transition = null;
							}
							updateSourceOrder(true);
						}, 300);
					}
					target.classList.remove("drag");
				},
				cancel: function(event, position, target) {
					target.classList.remove("drag");
				}
			}, document.querySelector("#sources"));
		} else {
			sourceArrangeDrag.setOptions({enabled: true});
		}
		$("#toggle-source-arrange-button").text("Sources Arranged").toggleClass("black grey");
		updateSourceOrder(true); // Moves all sources to "enabled" section.
		$(".enabled-sources .menu-item").removeClass("chevron");
	} else {
		arrangingSources = false;
		sourceArrangeDrag.setOptions({enabled: false});
		$("#toggle-source-arrange-button").text("Arrange Sources...").toggleClass("black grey");
		updateSourceOrder(true);
		$(".enabled-sources .menu-item, .disabled-sources .menu-item").addClass("chevron");
		if (sourcesArranged) {
			beo.sendToProduct("sources", {header: "arrangeSources", content: {sourceOrder: sourceOrder}});
		}
	}
}


function updateAliases() {
	for (extension in allSources) {
		if (allSources[extension].alias && allSources[extension].alias.icon) {
			icon = extensions.sources.assetPath+"/symbols-black/"+allSources[extension].alias.icon;
		} else {
			icon = extensions[extension].assetPath+"/symbols-black/"+extensions[extension].icon;
		}
		beo.setSymbol('.menu-item[data-extension-id="'+extension+'"] .menu-icon:not(.right)', icon);
		if (allSources[extension].alias && allSources[extension].alias.name) {
			$('.menu-item[data-extension-id="'+extension+'"] .menu-label').text(allSources[extension].alias.name);
			$("#"+extension+" .source-alias-control .menu-value").text(allSources[extension].alias.name).removeClass("button");
		} else {
			$('.menu-item[data-extension-id="'+extension+'"] .menu-label').text(extensions[extension].title);
			$("#"+extension+" .source-alias-control .menu-value").text("Set...").addClass("button");
		}
	}
}



function showStartableSources() {
	$(".startable-sources").empty();
	for (s in sourceOrder) {
		source = sourceOrder[s];
		if (allSources[source].startable) {
			menuOptions = {
				label: extensions[source].title,
				//value: $("#"+startableSources[source].extension).attr("data-menu-title"),
				icon: extensions[source].assetPath+"/symbols-black/"+extensions[source].icon,
				onclick: "sources.startSource('"+source+"');"
			}
			if (source == focusedSource) {
				menuOptions.iconRight = "common/symbols-black/volume.svg";
			} else {
				//menuOptions.value = "Play";
				//menuOptions.valueAsButton = true;
			}
			if (allSources[source].metadata.title) {
				trackInfoString = "<strong>"+allSources[source].metadata.title+"</strong>";
				if (allSources[source].metadata.artist) trackInfoString += " — "+allSources[source].metadata.artist;
				menuOptions.customMarkup = "<p>"+trackInfoString+"</p>";
			}
			$(".startable-sources").append(beo.createMenuItem(menuOptions));
		}
	}
	beo.ask("startable-sources-prompt");
}

function startSource(sourceID) {
	beo.send({target: "sources", header: "startSource", content: {sourceID: sourceID}});
	beo.ask();
}

var aliasSource = null;
function setAlias(extension, alias, defaultAlias) {
	if (!alias && !defaultAlias) {
		aliasSource = extension;
		beo.send({target: "sources", header: "getDefaultAliases"});
	} else {
		if (!alias) { // Remove alias.
			beo.send({target: "sources", header: "setAlias", content: {extension: extension, alias: null}});
		} else {
			beo.send({target: "sources", header: "setAlias", content: {extension: extension, alias: alias, defaultAlias: defaultAlias}});
		}
		beo.ask();
	}
}

function testSetActive(extension, active) {
	if (allSources[extension]) {
		if (active) {
			currentSource = extension;
			focusedSource = extension;
		} else {
			currentSource = null;
			focusedSource = null;
		}
		allSources[extension].active = active;
		showActiveSources();
	}
}

return {
	showStartableSources: showStartableSources,
	startSource: startSource,
	setAlias: setAlias,
	toggleArrange: toggleArrange,
	testSetActive: testSetActive
}

})();