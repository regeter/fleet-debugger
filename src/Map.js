// src/Map.js
import { useEffect, useRef, useState } from "react";
// import { Wrapper, Status } from "@googlemaps/react-wrapper"; // Removed
import { APIProvider, useMapsLibrary } from "@vis.gl/react-google-maps"; // Added
import _ from "lodash";
import { getQueryStringValue, setQueryStringValue } from "./queryString";
import Utils, { log } from "./Utils";
import PolylineCreation from "./PolylineCreation";
import { decode } from "s2polyline-ts";
import TrafficPolyline from "./TrafficPolyline";
import { TripObjects } from "./TripObjects";
import { getColor } from "./Trip";

let minDate;
let maxDate;
let map; // Global map instance
let apikey; // Still needed for APIProvider, but set in the Map component
let mapId; // Used in mapOptions
let dataMakers = [];
let trafficLayer;
const bubbleMap = {};
const toggleHandlers = {};
let panorama;
let jwt;
let projectId;
let locationProvider;
let tripLogs;
let taskLogs;
let setFeaturedObject;
let focusSelectedRow;
let setTimeRange;

// Removed render function for Wrapper status

/*
Creates the map object using a journeySharing location
provider.
*/
function initializeMapObject(element) {
  log("initializeMapObject: Initializing with element:", element);
  // In a more normal implementation authTokenFetcher
  // would actually be making a RPC to a backend to generate
  // the jwt.  For debugging use cases the jwt gets bundled into
  // the extracted log data.
  function authTokenFetcher(options) {
    // TODO #25 - bake in actual expiration time -- and give a
    // better error message for expired jwts
    console.log("Ignoring options using prebuilt jwt", options);
    log("authTokenFetcher: Called with options:", options);
    const authToken = {
      token: jwt,
    };
    return authToken;
  }

  if (!window.google || !window.google.maps || !window.google.maps.journeySharing) {
    console.error("initializeMapObject: Google Maps API or Journey Sharing library not loaded.");
    log("initializeMapObject: Google Maps API or Journey Sharing library not loaded.");
    return null;
  }

  log("initializeMapObject: Creating FleetEngineTripLocationProvider with projectId:", projectId);
  locationProvider = new window.google.maps.journeySharing.FleetEngineTripLocationProvider({
    projectId,
    authTokenFetcher,
  });

  log("initializeMapObject: Creating JourneySharingMapView with mapId:", mapId);
  const jsMapView = new window.google.maps.journeySharing.JourneySharingMapView({
    element: element,
    locationProvider,
    mapOptions: {
      mapId: mapId,
      mapTypeControl: true,
      streetViewControl: true,
    },
  });
  const initializedMap = jsMapView.map;
  log("initializeMapObject: JourneySharingMapView created. Map instance:", initializedMap);
  return initializedMap;
}

function MyMapComponent(props) {
  const mapRef = useRef(null);
  const [mapInitialized, setMapInitialized] = useState(false);

  const journeySharingLib = useMapsLibrary("journeySharing");
  const geometryLib = useMapsLibrary("geometry");

  const [showPolylineUI, setShowPolylineUI] = useState(false);
  const [polylines, setPolylines] = useState([]);
  const [buttonPosition, setButtonPosition] = useState({ top: 0, left: 0 });
  const [isFollowingVehicle, setIsFollowingVehicle] = useState(false);
  const lastValidPositionRef = useRef(null);

  // Effect 1: Initialize the map object once libraries and ref are ready
  useEffect(() => {
    // Check if libraries are loaded, ref is current, and global map is not already set
    if (journeySharingLib && geometryLib && mapRef.current && !map) {
      log("MyMapComponent Effect 1: Initializing map object...");
      const newMapInstance = initializeMapObject(mapRef.current);
      if (newMapInstance) {
        window.map = newMapInstance; // Assign to global 'map' (consider avoiding window global if 'map' is module global)
        map = newMapInstance; // Assign to module global 'map'
        setMapInitialized(true);
        log("MyMapComponent Effect 1: Map object created and 'mapInitialized' set to true.");
      } else {
        console.error("Map initialization failed in MyMapComponent's first effect.");
        log("MyMapComponent Effect 1: Map initialization failed, 'map' is null.");
      }
    } else {
      if (!journeySharingLib) log("MyMapComponent Effect 1: Waiting for Journey Sharing library.");
      if (!geometryLib) log("MyMapComponent Effect 1: Waiting for Geometry library.");
      if (!mapRef.current) log("MyMapComponent Effect 1: Waiting for mapRef.");
      if (map) log("MyMapComponent Effect 1: Map already initialized.");
    }
  }, [journeySharingLib, geometryLib]); // mapRef.current stability is assumed after first render.

  // Effect 2: Setup map properties, controls, and initial view once map is initialized
  useEffect(() => {
    if (!mapInitialized || !map) {
      if (!map) log("MyMapComponent Effect 2: Aborting, global map instance not ready.");
      else if (!mapInitialized) log("MyMapComponent Effect 2: Aborting, mapInitialized is false.");
      return;
    }
    log("MyMapComponent Effect 2: Map is initialized, proceeding with setup.");

    const vehicleBounds = addTripPolys(map); // This also adds a map click listener
    const urlZoom = getQueryStringValue("zoom");
    const urlCenter = getQueryStringValue("center");
    const urlHeading = getQueryStringValue("heading");

    if (urlZoom && urlCenter) {
      log("MyMapComponent Effect 2: setting zoom & center from url", urlZoom, urlCenter);
      map.setZoom(parseInt(urlZoom));
      map.setCenter(JSON.parse(urlCenter));
    } else if (vehicleBounds && !vehicleBounds.isEmpty()) {
      log("MyMapComponent Effect 2: fitting bounds to vehicle data.");
      map.fitBounds(vehicleBounds);
    } else {
      log("MyMapComponent Effect 2: No vehicle bounds or URL params, using default or waiting.");
      // map.setCenter({ lat: 0, lng: 0 }); map.setZoom(2); // Default if needed
    }
    if (urlHeading) {
      map.setHeading(parseInt(urlHeading));
    }
    map.setOptions({ maxZoom: 100 });

    const polylineButton = document.createElement("button");
    polylineButton.textContent = "Add Polyline";
    polylineButton.className = "map-button";
    polylineButton.onclick = (event) => {
      log("Polyline button clicked - MyMapComponent Effect 2");
      const rect = event.target.getBoundingClientRect();
      setButtonPosition({ top: rect.bottom, left: rect.left });
      setShowPolylineUI((prev) => !prev);
    };
    map.controls[window.google.maps.ControlPosition.TOP_LEFT].push(polylineButton);

    const followButton = document.createElement("div");
    followButton.className = "follow-vehicle-button";
    followButton.innerHTML = `
      <div class="follow-vehicle-background"></div>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -10 20 20" width="24" height="24" class="follow-vehicle-chevron">
        <path d="M -10,10 L 0,-10 L 10,10 L 0,5 z" fill="#4285F4" stroke="#4285F4" stroke-width="1"/>
      </svg>
    `;
    followButton.onclick = () => {
      log("Follow vehicle button clicked - MyMapComponent Effect 2");
      recenterOnVehicle();
    };
    map.controls[window.google.maps.ControlPosition.LEFT_BOTTOM].push(followButton);
    updateFollowButtonAppearance();

    const headingChangeListener = map.addListener("heading_changed", () => {
      log("MyMapComponent: heading_changed event");
      setQueryStringValue("heading", map.getHeading());
    });
    const dragStartListener = map.addListener("dragstart", () => {
      setIsFollowingVehicle(false);
      log("MyMapComponent: Follow mode disabled due to map drag (dragstart event)");
    });
    const centerChangedDebounced = _.debounce(() => {
      if (map && map.getCenter) {
        log("MyMapComponent: center_changed event (debounced)");
        setQueryStringValue("center", JSON.stringify(map.getCenter().toJSON()));
      } else {
        log("MyMapComponent: center_changed event (debounced) - map not available for getCenter");
      }
    }, 100);
    const centerChangedListener = map.addListener("center_changed", centerChangedDebounced);

    return () => {
      log("MyMapComponent Effect 2: Cleaning up map controls and listeners.");
      if (map && map.controls && window.google && window.google.maps) {
        if (map.controls[window.google.maps.ControlPosition.TOP_LEFT]) {
          map.controls[window.google.maps.ControlPosition.TOP_LEFT].clear();
        }
        if (map.controls[window.google.maps.ControlPosition.LEFT_BOTTOM]) {
          map.controls[window.google.maps.ControlPosition.LEFT_BOTTOM].clear();
        }
      }
      if (window.google && window.google.maps && window.google.maps.event) {
        if (headingChangeListener) google.maps.event.removeListener(headingChangeListener);
        if (dragStartListener) google.maps.event.removeListener(dragStartListener);
        if (centerChangedListener) google.maps.event.removeListener(centerChangedListener);
      }
      centerChangedDebounced.cancel();
      // Note: The click listener in addTripPolys needs careful management if addTripPolys is called multiple times.
      // This cleanup doesn't explicitly remove it.
    };
  }, [mapInitialized]);

  useEffect(() => {
    if (!mapInitialized || !map) {
      log("MyMapComponent updateFollowButtonAppearance effect: map not ready, skipping.");
      return;
    }
    log("MyMapComponent: updateFollowButtonAppearance effect triggered. isFollowingVehicle:", isFollowingVehicle);
    updateFollowButtonAppearance();
  }, [isFollowingVehicle, mapInitialized]);

  const updateFollowButtonAppearance = () => {
    log("updateFollowButtonAppearance: updating appearance, isFollowingVehicle: " + isFollowingVehicle);
    const followButton = document.querySelector(".follow-vehicle-button");
    if (followButton) {
      if (isFollowingVehicle) {
        followButton.classList.add("active");
        log("updateFollowButtonAppearance: Follow vehicle button updated to active state");
      } else {
        followButton.classList.remove("active");
        log("updateFollowButtonAppearance: Follow vehicle button updated to inactive state");
      }
    } else {
      log("updateFollowButtonAppearance: Follow vehicle button not found in DOM.");
    }
  };

  const handlePolylineSubmit = (waypoints, properties) => {
    if (!mapInitialized || !map || !window.google || !window.google.maps) {
      log("handlePolylineSubmit: Map not ready or Google Maps API not available, cannot create polyline.");
      return;
    }
    log(`handlePolylineSubmit: Creating polyline with ${waypoints.length} waypoints.`);
    const path = waypoints.map((wp) => new window.google.maps.LatLng(wp.latitude, wp.longitude));
    const arrowIcon = {
      path: window.google.maps.SymbolPath.FORWARD_OPEN_ARROW,
      scale: properties.strokeWeight / 2,
      strokeColor: properties.color,
    };
    const polyline = new window.google.maps.Polyline({
      path: path,
      geodesic: true,
      strokeColor: properties.color,
      strokeOpacity: properties.opacity,
      strokeWeight: properties.strokeWeight,
      icons: [
        { icon: arrowIcon, offset: "0%" },
        { icon: arrowIcon, offset: "100%" },
      ],
    });
    polyline.setMap(map);
    setPolylines((prevPolylines) => [...prevPolylines, polyline]);
    log(
      `Polyline ${polylines.length + 1} created with color: ${properties.color}, opacity: ${
        properties.opacity
      }, stroke weight: ${properties.strokeWeight}`
    );
  };

  const recenterOnVehicle = () => {
    log("recenterOnVehicle: Attempting to recenter.");
    if (!mapInitialized || !map) {
      log("recenterOnVehicle: Map not ready, cannot recenter.");
      return;
    }
    let position = null;
    if (props.selectedRow && props.selectedRow.lastlocation && props.selectedRow.lastlocation.rawlocation) {
      position = props.selectedRow.lastlocation.rawlocation;
      log(`recenterOnVehicle: Found position in selected row: ${position.latitude}, ${position.longitude}`);
    } else if (lastValidPositionRef.current) {
      position = lastValidPositionRef.current;
      log(`recenterOnVehicle: Using last cached valid position: ${position.lat}, ${position.lng}`);
    }

    if (!position) {
      log("recenterOnVehicle: No vehicle position found to center on.");
    }

    if (position && typeof position.latitude !== "undefined") {
      map.setCenter({ lat: position.latitude, lng: position.longitude });
      map.setZoom(17);
      log(`recenterOnVehicle: Map centered to ${position.latitude}, ${position.longitude}.`);
    }
    setIsFollowingVehicle((prev) => {
      const newState = !prev;
      log(`recenterOnVehicle: Toggled isFollowingVehicle to ${newState}.`);
      return newState;
    });
  };

  useEffect(() => {
    if (!mapInitialized || !map) {
      log("MyMapComponent rangeStart/rangeEnd effect: map not ready, skipping update.");
      return;
    }
    log(
      "MyMapComponent: rangeStart/rangeEnd effect triggered. rangeStart:",
      props.rangeStart,
      "rangeEnd:",
      props.rangeEnd
    );
    const updateMap = () => {
      minDate = new Date(props.rangeStart);
      maxDate = new Date(props.rangeEnd);
      addTripPolys(map); // Ensure this is safe and potentially idempotent for listeners
      _.forEach(toggleHandlers, (handler, name) => {
        if (bubbleMap[name]) {
          // If toggle was previously active
          log(`MyMapComponent rangeStart/rangeEnd effect: Re-applying toggle ${name}.`);
          handler(true); // Re-apply active toggles
        }
      });
    };
    const debouncedUpdateMap = _.debounce(updateMap, 200);
    debouncedUpdateMap();
    return () => {
      log("MyMapComponent rangeStart/rangeEnd effect: Cancelling debounced updateMap.");
      debouncedUpdateMap.cancel();
    };
  }, [props.rangeStart, props.rangeEnd, mapInitialized]);

  useEffect(() => {
    if (!mapInitialized || !map) {
      log("MyMapComponent selectedRow effect: map not ready, skipping update for selectedRow:", props.selectedRow);
      return;
    }
    if (!props.selectedRow) {
      log("MyMapComponent selectedRow effect: no selected row, skipping.");
      return;
    }
    log("MyMapComponent: selectedRow effect triggered for props.selectedRow:", props.selectedRow);

    // Clear ALL route segment polylines (those marked with isRouteSegment)
    const remainingPolylines = [];
    polylines.forEach((polyline) => {
      if (polyline.isRouteSegment) {
        polyline.setMap(null);
        log("MyMapComponent selectedRow effect: Removing previous route segment polyline.");
      } else {
        remainingPolylines.push(polyline);
      }
    });
    setPolylines(remainingPolylines); // Update state with non-route-segment polylines

    const eventType = props.selectedRow["@type"];
    const isTripEvent = ["getTrip", "updateTrip", "createTrip"].includes(eventType);

    let newRoutePolylines = [];

    if (isTripEvent) {
      const routeSegment = _.get(props.selectedRow, "response.currentroutesegment");
      if (routeSegment) {
        log("MyMapComponent selectedRow effect: Processing trip event route segment.");
        try {
          const decodedPoints = decode(routeSegment);
          if (decodedPoints && decodedPoints.length > 0) {
            const validWaypoints = decodedPoints.map((point) => ({
              lat: point.latDegrees(),
              lng: point.lngDegrees(),
            }));
            const trafficPolyline = new TrafficPolyline({
              path: validWaypoints,
              zIndex: 3,
              isTripEvent: true,
              map: map,
            });
            trafficPolyline.polylines.forEach((p) => (p.isRouteSegment = true)); // Mark them
            newRoutePolylines.push(...trafficPolyline.polylines);
            log("MyMapComponent selectedRow effect: Added trip event TrafficPolyline.");
          }
        } catch (error) {
          console.error("Error processing trip event polyline:", error);
          log("MyMapComponent selectedRow effect: Error processing trip event polyline:", error);
        }
      }
    }

    const generalRouteSegment =
      _.get(props.selectedRow, "request.vehicle.currentroutesegment") ||
      _.get(props.selectedRow, "lastlocation.currentroutesegment");

    if (generalRouteSegment) {
      log("MyMapComponent selectedRow effect: Processing general route segment.");
      try {
        const decodedPoints = decode(generalRouteSegment);
        if (decodedPoints && decodedPoints.length > 0) {
          const validWaypoints = decodedPoints.map((point) => ({
            lat: point.latDegrees(),
            lng: point.lngDegrees(),
          }));
          const trafficRendering =
            _.get(props.selectedRow, "request.vehicle.currentroutesegmenttraffic.trafficrendering") ||
            _.get(props.selectedRow, "lastlocation.currentroutesegmenttraffic.trafficrendering");
          const location = _.get(props.selectedRow.lastlocation, "location");
          const trafficPolyline = new TrafficPolyline({
            path: validWaypoints,
            zIndex: 2,
            trafficRendering: structuredClone(trafficRendering),
            currentLatLng: location,
            map: map,
          });
          trafficPolyline.polylines.forEach((p) => (p.isRouteSegment = true)); // Mark them
          newRoutePolylines.push(...trafficPolyline.polylines);
          log("MyMapComponent selectedRow effect: Added general TrafficPolyline.");
        }
      } catch (error) {
        console.error("Error processing route segment polyline:", error);
        log("MyMapComponent selectedRow effect: Error processing general route segment polyline:", error);
      }
    }
    if (newRoutePolylines.length > 0) {
      setPolylines((prev) => [...prev, ...newRoutePolylines]);
    }
  }, [props.selectedRow, mapInitialized]);

  useEffect(() => {
    if (!mapInitialized || !map) {
      log("MyMapComponent dataMakers effect: map not ready, skipping update.");
      return;
    }
    const data = props.selectedRow;
    log("MyMapComponent: dataMakers effect triggered. SelectedRow:", data, "isFollowingVehicle:", isFollowingVehicle);

    _.forEach(dataMakers, (m) => m.setMap(null));
    dataMakers = [];

    if (!data || !window.google || !window.google.maps) {
      log("MyMapComponent dataMakers effect: No data or Google Maps API not ready.");
      return;
    }

    const markerSymbols = {
      /* ... original symbols ... */
    };
    markerSymbols.background = {
      path: window.google.maps.SymbolPath.CIRCLE,
      fillColor: "#FFFFFF",
      fillOpacity: 0.7,
      scale: 18,
      strokeColor: "#FFFFFF",
      strokeWeight: 2,
      strokeOpacity: 0.3,
    };
    markerSymbols.chevron = {
      path: "M -1,1 L 0,-1 L 1,1 L 0,0.5 z",
      fillColor: "#4285F4",
      fillOpacity: 1,
      scale: 10,
      strokeColor: "#4285F4",
      strokeWeight: 1,
      rotation: 0,
    };
    markerSymbols.rawLocation = {
      path: window.google.maps.SymbolPath.CIRCLE,
      fillColor: "#FF0000",
      fillOpacity: 1,
      scale: 2,
      strokeColor: "#FF0000",
      strokeWeight: 1,
    };

    const location = _.get(data.lastlocation, "location") || _.get(data.lastlocationResponse, "location");
    if (location) {
      lastValidPositionRef.current = { lat: location.latitude, lng: location.longitude };
      const heading = _.get(data.lastlocation, "heading") || _.get(data.lastlocationResponse, "heading") || 0;
      markerSymbols.chevron.rotation = heading;

      const backgroundMarker = new window.google.maps.Marker({
        position: { lat: location.latitude, lng: location.longitude },
        map: map,
        icon: markerSymbols.background,
        clickable: false,
        zIndex: 9,
      });
      const chevronMarker = new window.google.maps.Marker({
        position: { lat: location.latitude, lng: location.longitude },
        map: map,
        icon: markerSymbols.chevron,
        zIndex: 10,
      });
      dataMakers.push(backgroundMarker, chevronMarker);
      log("MyMapComponent dataMakers effect: Added background and chevron markers.");

      const rawLocation = _.get(data.lastlocation, "rawlocation");
      if (rawLocation) {
        const rawLocationMarker = new window.google.maps.Marker({
          position: { lat: rawLocation.latitude, lng: rawLocation.longitude },
          map: map,
          icon: markerSymbols.rawLocation,
          zIndex: 8,
          clickable: false,
        });
        dataMakers.push(rawLocationMarker);
        log("MyMapComponent dataMakers effect: Added raw location marker.");
      }

      if (isFollowingVehicle) {
        log("MyMapComponent dataMakers effect: Following vehicle, setting map center.");
        map.setCenter({ lat: location.latitude, lng: location.longitude });
      }
    } else {
      log("MyMapComponent dataMakers effect: No location found in selected row.");
    }
  }, [props.selectedRow, isFollowingVehicle, mapInitialized]);

  // Handle toggles
  props.toggles.forEach((toggle) => {
    const id = toggle.id;
    useEffect(() => {
      const enabled = props.toggleOptions[id]; // Get current enabled state inside useEffect
      if (!mapInitialized || !map) {
        log(`MyMapComponent toggle effect for ${id}: map not ready, skipping. Enabled state: ${enabled}`);
        return;
      }
      log(`MyMapComponent: toggle effect for ${id}, enabled: ${enabled}`);
      if (toggleHandlers[id]) {
        toggleHandlers[id](enabled);
      } else {
        log(`MyMapComponent: No toggleHandler found for ${id}.`);
      }
    }, [props.toggleOptions[id], mapInitialized, id]); // Dependency on the specific toggle's state and mapInitialized
  });

  return (
    <>
      <div ref={mapRef} id="map-container-div" style={{ height: "100%", width: "100%" }} />
      {showPolylineUI && (
        <PolylineCreation
          onSubmit={handlePolylineSubmit}
          onClose={() => {
            log("PolylineCreation: Closing UI.");
            setShowPolylineUI(false);
          }}
          buttonPosition={buttonPosition}
        />
      )}
    </>
  );
}

function Map(props) {
  log("Map component: Rendering. Props received:", props);
  tripLogs = props.logData.tripLogs;
  taskLogs = props.logData.taskLogs;
  minDate = new Date(props.rangeStart); // Initialize minDate based on props
  maxDate = new Date(props.rangeEnd); // Initialize maxDate based on props

  const urlParams = new URLSearchParams(window.location.search);
  // apikey is now module-global, used by APIProvider below
  apikey = urlParams.get("apikey") || props.logData.apikey;
  mapId = urlParams.get("mapId") || props.logData.mapId; // Used in initializeMapObject
  jwt = props.logData.jwt; // Used in authTokenFetcher
  projectId = props.logData.projectId; // Used in FleetEngineTripLocationProvider

  // Globals for callbacks
  setFeaturedObject = props.setFeaturedObject;
  focusSelectedRow = props.focusSelectedRow;
  setTimeRange = props.setTimeRange;

  props.setCenterOnLocation((lat, lng) => {
    log(`Map: setCenterOnLocation called with lat: ${lat}, lng: ${lng}`);
    if (map && window.google && window.google.maps) {
      // 'map' is the global instance
      const newCenter = new window.google.maps.LatLng(lat, lng);
      map.setCenter(newCenter);
      map.setZoom(13); // Consider making zoom configurable or smarter
      log(`Map: Centered map to ${lat}, ${lng}.`);
    } else {
      console.error("Map not initialized or Google Maps API not ready when setCenterOnLocation called");
      log("Map: setCenterOnLocation - map instance or Google API not ready.");
    }
  });

  if (!apikey) {
    log("Map component: API key is missing. Map rendering will likely fail.");
    console.error("API Key is missing. Cannot load map.");
    return <div>Error: API Key is missing. Cannot load map.</div>;
  }
  log("Map component: Rendering with APIKey. APIKey length:", apikey?.length);

  return (
    <APIProvider
      apiKey={apikey}
      solutionChannel="GMP_visgl_reactgooglemaps_v1_GMP_FLEET_DEBUGGER"
      libraries={["journeySharing", "geometry"]}
    >
      <MyMapComponent
        // Pass necessary props down to MyMapComponent
        logData={props.logData} // Though globals like tripLogs are set, explicit props are good
        rangeStart={props.rangeStart}
        rangeEnd={props.rangeEnd}
        selectedRow={props.selectedRow}
        toggles={props.toggles}
        toggleOptions={props.toggleOptions}
        // Pass down callbacks that MyMapComponent's deeper functions might need
        setFeaturedObject={props.setFeaturedObject}
        setTimeRange={props.setTimeRange}
        focusSelectedRow={props.focusSelectedRow}
      />
    </APIProvider>
  );
}

function addTripPolys(currentMap) {
  log("addTripPolys: Adding trip polylines to map:", currentMap);
  if (!currentMap || !window.google || !window.google.maps) {
    log("addTripPolys: Map or Google API not available.");
    return null; // Or an empty LatLngBounds
  }
  const tripObjects = new TripObjects({
    map: currentMap,
    setFeaturedObject,
    setTimeRange,
  });
  const trips = tripLogs.getTrips();
  const vehicleBounds = new window.google.maps.LatLngBounds();

  // Clear existing map click listener if any, or ensure it's added only once.
  // For simplicity, this example doesn't manage removal/re-addition of this specific listener.
  // Be aware this might add multiple listeners if addTripPolys is called multiple times with the same map instance.
  currentMap.addListener("click", (event) => {
    const clickLocation = event.latLng;
    log("Map click detected at location:", clickLocation.lat(), clickLocation.lng());
    const closestEvent = findClosestEvent(clickLocation, 250); // 250 meters
    if (closestEvent) {
      log("Found closest event:", closestEvent.timestamp, closestEvent);
      setFeaturedObject(closestEvent);
      if (focusSelectedRow) {
        // Check if focusSelectedRow is defined
        setTimeout(() => focusSelectedRow(), 0);
      } else {
        log("focusSelectedRow function not available for map click.");
      }
    } else {
      log("No closest event found for map click.");
    }
  });

  _.forEach(trips, (trip) => {
    tripObjects.addTripVisuals(trip, minDate, maxDate);
    const tripCoords = trip.getPathCoords(minDate, maxDate);
    if (tripCoords.length > 0) {
      tripCoords.forEach((coord) => vehicleBounds.extend(coord));
    }
  });
  log("addTripPolys: Finished. Bounds:", vehicleBounds);
  return vehicleBounds;
}

function findClosestEvent(clickLocation, maxDistance) {
  log(`findClosestEvent: Searching around ${clickLocation.lat()}, ${clickLocation.lng()} within ${maxDistance}m.`);
  if (
    !tripLogs ||
    !window.google ||
    !window.google.maps ||
    !window.google.maps.geometry ||
    !window.google.maps.geometry.spherical
  ) {
    log("findClosestEvent: tripLogs or Google Maps Geometry library not available.");
    return null;
  }
  const logs = tripLogs.getLogs_(minDate, maxDate).value();
  let closestEvent = null;
  let closestDistance = maxDistance;

  logs.forEach((event) => {
    const rawLocation = _.get(event, "lastlocation.rawlocation");
    if (rawLocation && typeof rawLocation.latitude === "number" && typeof rawLocation.longitude === "number") {
      const eventLocation = new window.google.maps.LatLng(rawLocation.latitude, rawLocation.longitude);
      const distance = window.google.maps.geometry.spherical.computeDistanceBetween(clickLocation, eventLocation);
      if (distance < closestDistance) {
        closestEvent = event;
        closestDistance = distance;
      }
    }
  });

  if (closestEvent) {
    log(`findClosestEvent: Found closest event at distance: ${closestDistance} meters. Event:`, closestEvent);
  } else {
    log(`findClosestEvent: No events found within ${maxDistance} meters.`);
  }
  return closestEvent;
}

function GenerateBubbles(bubbleName, cb) {
  log(`GenerateBubbles: Factory created for ${bubbleName}.`);
  return (showBubble) => {
    log(`GenerateBubbles (${bubbleName}): Called with showBubble = ${showBubble}. Map instance:`, map);
    if (!map || !window.google || !window.google.maps) {
      log(`GenerateBubbles (${bubbleName}): Map or Google API not ready.`);
      return;
    }
    _.forEach(bubbleMap[bubbleName], (bubble) => bubble.setMap(null));
    delete bubbleMap[bubbleName];

    if (showBubble) {
      log(`GenerateBubbles (${bubbleName}): Showing bubbles.`);
      bubbleMap[bubbleName] = tripLogs
        .getLogs(minDate, maxDate)
        .map((le) => {
          const lastLocation = le.lastlocation;
          let rawlocation;
          let bubble = undefined;
          if (
            lastLocation &&
            (rawlocation = lastLocation.rawlocation) &&
            typeof rawlocation.latitude === "number" &&
            typeof rawlocation.longitude === "number"
          ) {
            bubble = cb(
              new window.google.maps.LatLng({
                lat: rawlocation.latitude,
                lng: rawlocation.longitude,
              }),
              lastLocation,
              le
            );
          }
          return bubble;
        })
        .compact()
        .value();
      log(`GenerateBubbles (${bubbleName}): ${bubbleMap[bubbleName].length} bubbles created.`);
    } else {
      log(`GenerateBubbles (${bubbleName}): Hiding bubbles.`);
    }
  };
}

// All toggleHandlers remain, assuming 'map', 'setFeaturedObject', 'setTimeRange', 'tripLogs', 'taskLogs' are available
// and google.maps objects (Circle, Polyline, etc.) are usable.

toggleHandlers["showGPSBubbles"] = GenerateBubbles("showGPSBubbles", (rawLocationLatLng, lastLocation) => {
  // ... (original logic, ensure google.maps.Circle, google.maps.event are used with window.google.maps)
  // Example for one:
  if (!window.google || !window.google.maps) return null;
  let color;
  switch (lastLocation.locationsensor) {
    case "GPS":
      color = "#11FF11";
      break;
    // ... other cases
    default:
      color = "#000000";
  }
  const accuracy = lastLocation.rawlocationaccuracy;
  if (accuracy) {
    let circ = new window.google.maps.Circle({
      /* ... options ... */ map: map,
      center: rawLocationLatLng,
      radius: accuracy,
    });
    window.google.maps.event.addListener(circ, "mouseover", () => {
      setFeaturedObject({
        /* ... */
      });
    });
    return circ;
  }
  return null;
});

toggleHandlers["showClientServerTimeDeltas"] = GenerateBubbles(
  "showClientServerTimeDeltas",
  (rawLocationLatLng, lastLocation, logEntry) => {
    if (!window.google || !window.google.maps) return null;
    const clientTimeStr = _.get(logEntry.lastlocationResponse, "rawlocationtime");
    const serverTimeStr = _.get(logEntry.lastlocationResponse, "servertime");
    if (clientTimeStr && serverTimeStr) {
      const clientDate = new Date(clientTimeStr);
      const serverDate = new Date(serverTimeStr);
      const timeDeltaSeconds = Math.abs(clientDate.getTime() - serverDate.getTime()) / 1000;
      let color = clientDate > serverDate ? "#0000F0" : "#0F0000";
      let circ = new window.google.maps.Circle({
        strokeColor: color,
        strokeOpacity: 0.6,
        strokeWeight: 2,
        fillColor: color,
        fillOpacity: 0.2,
        map,
        center: rawLocationLatLng,
        radius: timeDeltaSeconds,
      });
      window.google.maps.event.addListener(circ, "mouseover", () => {
        setFeaturedObject({ timeDeltaSeconds: timeDeltaSeconds, serverDate: serverDate, clientDate: clientDate });
      });
      return circ;
    }
    return null;
  }
);

toggleHandlers["showHeading"] = GenerateBubbles("showHeading", (rawLocationLatLng, lastLocation, logEntry) => {
  if (!window.google || !window.google.maps || !window.google.maps.geometry || !window.google.maps.geometry.spherical)
    return null;
  const heading = _.get(logEntry.lastlocation, "heading");
  const accuracy = _.get(logEntry.lastlocation, "headingaccuracy");
  const arrowLength = 20;
  if (!(heading && accuracy)) return null;

  const headingLine = new window.google.maps.Polyline({
    strokeColor: "#0000F0",
    strokeOpacity: 0.6,
    strokeWeight: 2,
    icons: [
      {
        icon: { path: window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW, strokeColor: "#0000FF", strokeWeight: 4 },
        offset: "100%",
      },
    ],
    map,
    path: [
      rawLocationLatLng,
      window.google.maps.geometry.spherical.computeOffset(rawLocationLatLng, arrowLength, heading),
    ],
  });
  window.google.maps.event.addListener(headingLine, "click", () => {
    if (document.getElementById("map-container-div")) {
      // Check if map div exists for panorama
      panorama = new window.google.maps.StreetViewPanorama(document.getElementById("map-container-div"), {
        // Use the new div id
        position: rawLocationLatLng,
        pov: { heading: heading, pitch: 10 },
        addressControlOptions: { position: window.google.maps.ControlPosition.BOTTOM_CENTER },
        linksControl: false,
        panControl: false,
        enableCloseButton: true,
      });
      log("Loaded panorama", panorama);
    } else {
      log("Cannot load panorama, map container div not found.");
    }
  });
  return headingLine;
});

toggleHandlers["showSpeed"] = GenerateBubbles("showSpeed", (rawLocationLatLng, lastLocation) => {
  if (!window.google || !window.google.maps) return null;
  const speed = lastLocation.speed;
  if (lastLocation.speed === undefined) return null;
  const color = speed < 0 ? "#FF0000" : "#00FF00";
  return new window.google.maps.Circle({
    strokeColor: color,
    strokeOpacity: 0.5,
    fillColor: color,
    fillOpacity: 0.5,
    map,
    center: rawLocationLatLng,
    radius: Math.abs(speed),
  });
});

toggleHandlers["showTripStatus"] = GenerateBubbles("showTripStatus", (rawLocationLatLng, lastLocation, le) => {
  if (!window.google || !window.google.maps) return null;
  let color,
    radius = 5;
  const tripStatus = tripLogs.getTripStatusAtDate(le.date);
  switch (tripStatus) {
    case "NEW":
      color = "#002200";
      radius = 30;
      break;
    case "ENROUTE_TO_PICKUP":
      color = "#FFFF00";
      break;
    // ... other cases from original
    default:
      color = "#000000";
  }
  const statusCirc = new window.google.maps.Circle({
    strokeColor: color,
    strokeOpacity: 0.5,
    fillColor: color,
    fillOpacity: 0.5,
    map,
    center: rawLocationLatLng,
    radius: radius,
  });
  window.google.maps.event.addListener(statusCirc, "mouseover", () => {
    setFeaturedObject({ tripStatus: tripStatus });
  });
  return statusCirc;
});

toggleHandlers["showTraffic"] = function (enabled) {
  log(`Toggle showTraffic: ${enabled}. Map instance:`, map);
  if (!map || !window.google || !window.google.maps) {
    log("Toggle showTraffic: Map or Google API not ready.");
    return;
  }
  if (!trafficLayer) {
    log("Toggle showTraffic: Creating new TrafficLayer.");
    trafficLayer = new window.google.maps.TrafficLayer();
  }
  if (enabled) {
    log("Toggle showTraffic: Setting traffic layer to map.");
    trafficLayer.setMap(map);
  } else {
    log("Toggle showTraffic: Removing traffic layer from map.");
    trafficLayer.setMap(null);
  }
};

toggleHandlers["showDwellLocations"] = function (enabled) {
  log(`Toggle showDwellLocations: ${enabled}.`);
  if (!map || !window.google || !window.google.maps) {
    log("Toggle showDwellLocations: Map or Google API not ready.");
    return;
  }
  const bubbleName = "showDwellLocations";
  const dwellLocations = tripLogs.getDwellLocations(minDate, maxDate);
  _.forEach(bubbleMap[bubbleName], (bubble) => bubble.setMap(null));
  delete bubbleMap[bubbleName];

  if (enabled) {
    log("Toggle showDwellLocations: Enabling dwell location bubbles.");
    bubbleMap[bubbleName] = _.map(dwellLocations, (dl) => {
      const circ = new window.google.maps.Circle({
        /* ... options ... */ map,
        center: dl.leaderCoords,
        radius: dl.updates * 3,
      });
      window.google.maps.event.addListener(circ, "mouseover", () => {
        setFeaturedObject({
          startDate: dl.startDate,
          duration: Utils.formatDuration(dl.endDate - dl.startDate),
          endDate: dl.endDate,
        });
      });
      return circ;
    });
    log(`Toggle showDwellLocations: ${bubbleMap[bubbleName].length} dwell bubbles created.`);
  } else {
    log("Toggle showDwellLocations: Disabling dwell location bubbles.");
  }
};

toggleHandlers["showTasksAsCreated"] = function (enabled) {
  log(`Toggle showTasksAsCreated: ${enabled}.`);
  if (!map || !window.google || !window.google.maps) {
    log("Toggle showTasksAsCreated: Map or Google API not ready.");
    return;
  }
  const bubbleName = "showTasksAsCreated";
  // Assuming taskLogs is available and has getTasks method
  if (!taskLogs) {
    log("Toggle showTasksAsCreated: taskLogs not available.");
    return;
  }
  const tasks = taskLogs.getTasks(maxDate).value();
  _.forEach(bubbleMap[bubbleName], (bubble) => bubble.setMap(null));
  delete bubbleMap[bubbleName];

  function getIcon(task) {
    /* ... original logic ... */
    const outcome = task.taskoutcome || "unknown";
    const urlBase = "http://maps.google.com/mapfiles/kml/shapes/";
    const icon = { url: urlBase, scaledSize: new window.google.maps.Size(35, 35) };
    if (outcome.match("SUCCEEDED")) icon.url += "flag.png";
    else if (outcome.match("FAIL")) icon.url += "caution.png";
    else icon.url += "shaded_dot.png";
    return icon;
  }

  if (enabled) {
    log("Toggle showTasksAsCreated: Enabling task markers.");
    bubbleMap[bubbleName] = _(tasks)
      .map((task) => {
        // ... (original marker and polyline creation logic using window.google.maps)
        const marker = new window.google.maps.Marker({
          /* ... */
        });
        // ...
        let ret = [marker];
        if (task.taskoutcomelocation) {
          const offSetPath = new window.google.maps.Polyline({
            /* ... */
          });
          ret.push(offSetPath);
        }
        return ret;
      })
      .flatten()
      .value();
    log(`Toggle showTasksAsCreated: ${bubbleMap[bubbleName].length} task-related map objects created.`);
  } else {
    log("Toggle showTasksAsCreated: Disabling task markers.");
  }
};

toggleHandlers["showPlannedPaths"] = function (enabled) {
  log(`Toggle showPlannedPaths: ${enabled}.`);
  if (!map || !window.google || !window.google.maps) {
    log("Toggle showPlannedPaths: Map or Google API not ready.");
    return;
  }
  const bubbleName = "showPlannedPaths";
  _.forEach(bubbleMap[bubbleName], (bubble) => bubble.setMap(null));
  delete bubbleMap[bubbleName];

  if (enabled) {
    log("Toggle showPlannedPaths: Enabling planned paths.");
    const trips = tripLogs.getTrips();
    bubbleMap[bubbleName] = trips
      .filter((trip) => trip.firstUpdate <= maxDate && trip.lastUpdate >= minDate && trip.getPlannedPath().length > 0)
      .map((trip) => {
        const plannedPath = trip.getPlannedPath();
        const path = new window.google.maps.Polyline({ /* ... options using getColor(trip.tripIdx) ... */ map });
        return path;
      });
    log(`Toggle showPlannedPaths: ${bubbleMap[bubbleName].length} planned paths created.`);
  } else {
    log("Toggle showPlannedPaths: Disabling planned paths.");
  }
};

toggleHandlers["showNavStatus"] = GenerateBubbles("showNavStatus", (rawLocationLatLng, lastLocation, le) => {
  if (!window.google || !window.google.maps) return null;
  const navStatus = le.navStatus;
  if (navStatus === undefined) return null;
  let color,
    radius = 5;
  switch (navStatus) {
    case "UNKNOWN_NAVIGATION_STATUS":
      color = "#222222";
      break;
    // ... other cases
    default:
      color = "#000000";
  }
  const statusCirc = new window.google.maps.Circle({
    /* ... options ... */ map,
    center: rawLocationLatLng,
    radius: radius,
  });
  window.google.maps.event.addListener(statusCirc, "mouseover", () => {
    setFeaturedObject({
      /* ... */
    });
  });
  return statusCirc;
});

toggleHandlers["showETADeltas"] = function (enabled) {
  log(`Toggle showETADeltas: ${enabled}.`);
  if (!map || !window.google || !window.google.maps) {
    log("Toggle showETADeltas: Map or Google API not ready.");
    return;
  }
  const bubbleName = "showETADeltas";
  _.forEach(bubbleMap[bubbleName], (bubble) => bubble.setMap(null));
  delete bubbleMap[bubbleName];
  const etaDeltas = tripLogs.getETADeltas(minDate, maxDate);

  if (enabled) {
    log("Toggle showETADeltas: Enabling ETA delta bubbles.");
    bubbleMap[bubbleName] = _.map(etaDeltas, (etaDelta) => {
      const circ = new window.google.maps.Circle({
        /* ... options ... */ map,
        center: etaDelta.coords,
        radius: _.min([etaDelta.deltaInSeconds, 300]),
      });
      window.google.maps.event.addListener(circ, "mouseover", () => {
        setFeaturedObject({ etaDeltaInSeconds: etaDelta.deltaInSeconds });
      });
      return circ;
    });
    log(`Toggle showETADeltas: ${bubbleMap[bubbleName].length} ETA delta bubbles created.`);
  } else {
    log("Toggle showETADeltas: Disabling ETA delta bubbles.");
  }
};

toggleHandlers["showHighVelocityJumps"] = function (enabled) {
  log(`Toggle showHighVelocityJumps: ${enabled}.`);
  if (!map || !window.google || !window.google.maps) {
    log("Toggle showHighVelocityJumps: Map or Google API not ready.");
    return;
  }
  const bubbleName = "showHighVelocityJumps";
  // Assuming tripLogs.debouncedGetHighVelocityJumps is available
  tripLogs.debouncedGetHighVelocityJumps(minDate, maxDate, (jumps) => {
    log(
      `Toggle showHighVelocityJumps: debouncedGetHighVelocityJumps callback. ${jumps.length} jumps. Enabled: ${enabled}.`
    );
    _.forEach(bubbleMap[bubbleName], (bubble) => bubble.setMap(null));
    delete bubbleMap[bubbleName];
    if (enabled && map) {
      // Check map again in async callback
      bubbleMap[bubbleName] = _(jumps)
        .map((jump) => {
          // ... (original Polyline creation logic with window.google.maps)
          const path = new window.google.maps.Polyline({
            /* ... */
          });
          // ...
          return [path];
        })
        .flatten()
        .value();
      log(`Toggle showHighVelocityJumps: ${bubbleMap[bubbleName].length} high velocity jump paths created.`);
    } else if (!enabled) {
      log("Toggle showHighVelocityJumps: Disabling high velocity jumps, resetting time range.");
      // setTimeRange(tripLogs.minDate.getTime(), tripLogs.maxDate.getTime()); // Be careful with side effects in toggles
    }
  });
};

toggleHandlers["showMissingUpdates"] = function (enabled) {
  log(`Toggle showMissingUpdates: ${enabled}.`);
  if (!map || !window.google || !window.google.maps) {
    log("Toggle showMissingUpdates: Map or Google API not ready.");
    return;
  }
  const bubbleName = "showMissingUpdates";
  const missingUpdates = tripLogs.getMissingUpdates(minDate, maxDate);
  _.forEach(bubbleMap[bubbleName], (bubble) => bubble.setMap(null));
  delete bubbleMap[bubbleName];

  if (enabled) {
    log("Toggle showMissingUpdates: Enabling missing update markers.");
    bubbleMap[bubbleName] = _(missingUpdates)
      .map((update) => {
        // ... (original Polyline creation with window.google.maps and geometry.spherical)
        const path = new window.google.maps.Polyline({
          /* ... */
        });
        // ...
        return [path];
      })
      .flatten()
      .value();
    log(`Toggle showMissingUpdates: ${bubbleMap[bubbleName].length} missing update paths created.`);
  } else {
    log("Toggle showMissingUpdates: Disabling missing updates.");
    // setTimeRange(tripLogs.minDate.getTime(), tripLogs.maxDate.getTime()); // Side effect
  }
};

toggleHandlers["showLiveJS"] = function (enabled) {
  log(`Toggle showLiveJS: ${enabled}.`);
  if (!jwt) {
    log("Toggle showLiveJS: Issue #25 -- no/invalid jwt. Cannot enable.");
    return;
  }
  if (!locationProvider) {
    log("Toggle showLiveJS: locationProvider not initialized.");
    return;
  }
  if (enabled) {
    log("Toggle showLiveJS: Enabling live Journey Sharing.");
    locationProvider.tripId = _.last(tripLogs.getTripIDs()); // Make sure getTripIDs() is available
    log(`Toggle showLiveJS: Set tripId to ${locationProvider.tripId}`);
  } else {
    log("Toggle showLiveJS: Disabling live Journey Sharing.");
    locationProvider.tripId = "";
  }
};

export { Map as default };
