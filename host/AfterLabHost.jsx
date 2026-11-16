// =============================================================================
// AfterLabHost.jsx  —  ExtendScript host for AfterLab CEP extension
// Exposes all panel actions via $._AFTERLAB namespace.
// All public functions accept a JSON string arg and return a JSON string result.
// =============================================================================

$._AFTERLAB = (function () {

    "use strict";

    var TOOL_NAME = "AfterLab";

    var DEFAULTS = {
        precompName:  "Pre-Comp 1",
        gaussBlur:    20,
        solidName:    "Solid",
        bgSolidName:  "BG Solid",
        nullName:     "Null Controller",
        cameraName:   "Camera 1",
        vigName:      "Vignette"
    };

    // Macro slots survive across CEP evalScript calls within one AE session.
    var MACRO_SLOTS = [null, null, null, null, null, null, null, null];

    // ─────────────────────────────────────────────────────────────────────────
    // JSON helpers
    // ─────────────────────────────────────────────────────────────────────────

    function ok(data) {
        data = data || {};
        data.ok = true;
        return JSON.stringify(data);
    }

    function fail(msg) {
        return JSON.stringify({ ok: false, error: String(msg) });
    }

    function parseArgs(argsJson) {
        if (!argsJson || argsJson === "") return {};
        try { return JSON.parse(argsJson); } catch (e) { return {}; }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Core helpers
    // ─────────────────────────────────────────────────────────────────────────

    function getActiveComp() {
        var item = app.project.activeItem;
        if (!item || !(item instanceof CompItem)) return null;
        return item;
    }

    function getSelectedLayers(comp) {
        if (!comp) return [];
        return comp.selectedLayers || [];
    }

    function getFirstSelectedLayer(comp) {
        var sel = getSelectedLayers(comp);
        return sel.length > 0 ? sel[0] : null;
    }

    function getXfGroup(layer) {
        return layer.property("ADBE Transform Group");
    }

    function setLayerPos(xfGroup, x, y, z) {
        var posProp = xfGroup.property("ADBE Position");
        if (posProp.dimensionsSeparated) {
            xfGroup.property("ADBE Position_0").setValue(x);
            xfGroup.property("ADBE Position_1").setValue(y);
            if (z !== null && z !== undefined) {
                try { xfGroup.property("ADBE Position_2").setValue(z); } catch (e) {}
            }
        } else {
            var cur = posProp.value;
            if (cur.length === 2) {
                posProp.setValue([x, y]);
            } else {
                posProp.setValue([x, y, (z !== null && z !== undefined) ? z : cur[2]]);
            }
        }
    }

    function addEffectByMatchName(layer, matchName) {
        try { return layer.property("Effects").addProperty(matchName); } catch (e) { return null; }
    }

    // Number of KeyframeEase objects setTemporalEaseAtKey expects: spatial and color props take 1.
    function propertyDimensionCount(prop) {
        switch (prop.propertyValueType) {
            case PropertyValueType.OneD:
            case PropertyValueType.TwoD_SPATIAL:
            case PropertyValueType.ThreeD_SPATIAL:
            case PropertyValueType.COLOR: return 1;
            case PropertyValueType.TwoD: return 2;
            case PropertyValueType.ThreeD: return 3;
            default: return 0;
        }
    }

    function valueDistance(a, b) {
        if (a === null || a === undefined || b === null || b === undefined) return 0;
        if (typeof a === "number" && typeof b === "number") return Math.abs(a - b);
        if (a.length !== undefined && b.length !== undefined) {
            var len = Math.min(a.length, b.length);
            var sum = 0;
            for (var i = 0; i < len; i++) {
                var d = (a[i] - b[i]);
                sum += d * d;
            }
            return Math.sqrt(sum);
        }
        return 0;
    }

    function safeKeySpeed(prop, keyA, keyB) {
        try {
            var tA = prop.keyTime(keyA), tB = prop.keyTime(keyB);
            var dt = Math.abs(tB - tA);
            if (dt <= 0.000001) return 0;
            var vA = prop.keyValue(keyA), vB = prop.keyValue(keyB);
            var dist = valueDistance(vA, vB);
            return dist / dt;
        } catch (e) {
            return 0;
        }
    }

    function createAdjustmentLayer(comp, layerName) {
        var adj = comp.layers.addSolid(
            [1, 1, 1], layerName || "Adjustment Layer",
            comp.width, comp.height, comp.pixelAspect, comp.duration
        );
        adj.adjustmentLayer = true;
        try { adj.label = 5; } catch (e) {}
        return adj;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Macro helpers
    // ─────────────────────────────────────────────────────────────────────────

    function getOwningEffectGroup(prop) {
        var cur = prop;
        while (cur && cur.parentProperty) {
            if (cur.parentProperty.matchName === "ADBE Effect Parade") return cur;
            cur = cur.parentProperty;
        }
        return null;
    }

    function getMacroSourceEffects(layer) {
        var selectedProps = layer.selectedProperties || [];
        var found = [], seen = {}, i, eff;
        for (i = 0; i < selectedProps.length; i++) {
            eff = getOwningEffectGroup(selectedProps[i]);
            if (eff && !seen[eff.propertyIndex]) {
                found.push(eff);
                seen[eff.propertyIndex] = true;
            }
        }
        found.sort(function (a, b) { return a.propertyIndex - b.propertyIndex; });
        if (found.length > 0) return found;
        var parade = layer.property("ADBE Effect Parade");
        if (!parade || parade.numProperties === 0) return [];
        for (i = 1; i <= parade.numProperties; i++) found.push(parade.property(i));
        return found;
    }

    function collectEffectPropertySnapshots(group, path, outList) {
        for (var i = 1; i <= group.numProperties; i++) {
            var prop = group.property(i);
            var nextPath = path.concat([i]);
            if (prop.propertyType === PropertyType.PROPERTY) {
                try {
                    if (prop.propertyValueType !== PropertyValueType.NO_VALUE) {
                        outList.push({ path: nextPath.join("."), value: prop.value });
                    }
                } catch (e) {}
            } else {
                collectEffectPropertySnapshots(prop, nextPath, outList);
            }
        }
    }

    function snapshotEffect(effectGroup) {
        var snap = { matchName: effectGroup.matchName, name: effectGroup.name, enabled: true, props: [] };
        try { snap.enabled = effectGroup.enabled; } catch (e) {}
        collectEffectPropertySnapshots(effectGroup, [], snap.props);
        return snap;
    }

    function resolvePropertyPath(root, pathString) {
        var parts = pathString.split(".");
        var cur = root;
        for (var i = 0; i < parts.length; i++) {
            cur = cur.property(parseInt(parts[i], 10));
            if (!cur) return null;
        }
        return cur;
    }

    function applyEffectSnapshotToLayer(layer, snap) {
        var fx = addEffectByMatchName(layer, snap.matchName);
        if (!fx) throw new Error("Could not add effect: " + snap.matchName);
        try { fx.name = snap.name; } catch (e) {}
        try { fx.enabled = snap.enabled; } catch (e) {}
        for (var i = 0; i < snap.props.length; i++) {
            try {
                var prop = resolvePropertyPath(fx, snap.props[i].path);
                if (prop) prop.setValue(snap.props[i].value);
            } catch (e) {}
        }
        return fx;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLIC API
    // ─────────────────────────────────────────────────────────────────────────

    function preCompose(argsJson) {
        var args = parseArgs(argsJson);
        var comp = getActiveComp();
        if (!comp) return fail("No active composition.");
        var layers = getSelectedLayers(comp);
        if (!layers.length) return fail("Select at least one layer first.");
        var name = args.name || DEFAULTS.precompName;
        var indices = [];
        for (var i = 0; i < layers.length; i++) indices.push(layers[i].index);
        indices.sort(function (a, b) { return a - b; });
        app.beginUndoGroup("AfterLab: Pre-Compose");
        try {
            comp.layers.precompose(indices, name, true);
            app.endUndoGroup();
            return ok({ message: "Pre-composed into \"" + name + "\"." });
        } catch (e) {
            app.endUndoGroup();
            return fail(e.toString());
        }
    }

    function centerLayers() {
        var comp = getActiveComp();
        if (!comp) return fail("No active composition.");
        var layers = getSelectedLayers(comp);
        if (!layers.length) return fail("Select at least one layer first.");
        var cx = comp.width / 2, cy = comp.height / 2;
        app.beginUndoGroup("AfterLab: Center Layers");
        var skipped = [];
        for (var i = 0; i < layers.length; i++) {
            try {
                var xfGroup = getXfGroup(layers[i]);
                var curPos = xfGroup.property("ADBE Position").value;
                var curZ = (curPos.length === 3) ? curPos[2] : null;
                setLayerPos(xfGroup, cx, cy, curZ);
            } catch (e) { skipped.push(layers[i].name); }
        }
        app.endUndoGroup();
        return ok({ skipped: skipped });
    }

    function saveFrame() {
        var comp = getActiveComp();
        if (!comp) return fail("No active composition.");
        var outputFile = File.saveDialog("Choose output path for frame PNG:", "PNG files:*.png,All files:*.*");
        if (!outputFile) return ok({ cancelled: true });
        app.beginUndoGroup("AfterLab: Save Frame");
        try {
            var t = comp.time;
            var rqItem = app.project.renderQueue.items.add(comp);
            rqItem.timeSpanStart = t;
            rqItem.timeSpanDuration = 1 / comp.frameRate;
            var om = rqItem.outputModules[1];
            try { om.applyTemplate("PNG Sequence"); } catch (e2) {
                try { om.applyTemplate("_Lossless"); } catch (e3) {}
            }
            om.file = new File(outputFile.fsName.replace(/\.png$/i, "") + ".png");
            app.endUndoGroup();
            return ok({ message: "Frame queued. Open the Render Queue panel and click Render to export." });
        } catch (e) {
            app.endUndoGroup();
            return fail(e.toString());
        }
    }

    function addAdjLayer() {
        var comp = getActiveComp();
        if (!comp) return fail("No active composition.");
        app.beginUndoGroup("AfterLab: Add Adjustment Layer");
        try {
            createAdjustmentLayer(comp, "Adjustment Layer");
            app.endUndoGroup();
            return ok({ message: "Adjustment layer added." });
        } catch (e) {
            app.endUndoGroup();
            return fail(e.toString());
        }
    }

    function addCamera() {
        var comp = getActiveComp();
        if (!comp) return fail("No active composition.");
        app.beginUndoGroup("AfterLab: Add Camera");
        try {
            var cam = comp.layers.addCamera(DEFAULTS.cameraName, [comp.width / 2, comp.height / 2]);
            try { cam.label = 13; } catch (e) {}
            var ctrl = comp.layers.addNull(comp.duration);
            ctrl.name = DEFAULTS.cameraName + " CTRL";
            ctrl.threeDLayer = true;
            try { ctrl.label = 8; } catch (e) {}
            var camXf = getXfGroup(cam);
            var ctrlXf = getXfGroup(ctrl);
            try { ctrlXf.property("ADBE Position").setValue(camXf.property("ADBE Position").value); } catch (e) {}
            try {
                ctrlXf.property("ADBE Rotate X").setValue(camXf.property("ADBE Rotate X").value);
                ctrlXf.property("ADBE Rotate Y").setValue(camXf.property("ADBE Rotate Y").value);
                ctrlXf.property("ADBE Rotate Z").setValue(camXf.property("ADBE Rotate Z").value);
            } catch (e) {}
            cam.parent = ctrl;
            app.endUndoGroup();
            return ok({ message: "Camera + controller null added." });
        } catch (e) {
            app.endUndoGroup();
            return fail(e.toString());
        }
    }

    function addSolid(argsJson) {
        var args = parseArgs(argsJson);
        var comp = getActiveComp();
        if (!comp) return fail("No active composition.");
        if (args.openNative) {
            // Try to open AE's native Solid Settings dialog.
            var commandId = 0;
            try {
                if (app.findMenuCommandId) {
                    commandId = app.findMenuCommandId("Solid...");
                    if (!commandId || commandId <= 0) commandId = app.findMenuCommandId("New Solid...");
                }
            } catch (e) {}
            if (commandId && commandId > 0) {
                try { app.executeCommand(commandId); return ok({ isNative: true }); } catch (e) {}
            }
            // Fallback: color picker.
            var picked = $.colorPicker(0x000000);
            if (picked === -1) return ok({ cancelled: true });
            args.color = [((picked >>> 16) & 0xFF) / 255, ((picked >>> 8) & 0xFF) / 255, (picked & 0xFF) / 255];
        }
        var color = args.color || [0, 0, 0];
        app.beginUndoGroup("AfterLab: Add Solid");
        try {
            comp.layers.addSolid(color, DEFAULTS.solidName, comp.width, comp.height, comp.pixelAspect, comp.duration);
            app.endUndoGroup();
            return ok({ message: "Solid layer added." });
        } catch (e) {
            app.endUndoGroup();
            return fail(e.toString());
        }
    }

    function addNull(argsJson) {
        var args = parseArgs(argsJson);
        var comp = getActiveComp();
        if (!comp) return fail("No active composition.");
        if (args.createNullAndParent) return createNullAndParent();
        app.beginUndoGroup("AfterLab: Add Null");
        try {
            var n = comp.layers.addNull(comp.duration);
            n.name = DEFAULTS.nullName;
            try { n.label = 8; } catch (e) {}
            app.endUndoGroup();
            return ok({ message: "Null object added." });
        } catch (e) {
            app.endUndoGroup();
            return fail(e.toString());
        }
    }

    function trimToTime() {
        var comp = getActiveComp();
        if (!comp) return fail("No active composition.");
        var layers = getSelectedLayers(comp);
        if (!layers.length) return fail("Select at least one layer first.");
        var t = comp.time;
        app.beginUndoGroup("AfterLab: Trim to Current Time");
        var skipped = [];
        try {
            for (var i = 0; i < layers.length; i++) {
                if (t > layers[i].inPoint) { layers[i].outPoint = t; }
                else { skipped.push(layers[i].name); }
            }
        } catch (e) {
            app.endUndoGroup();
            return fail(e.toString());
        }
        app.endUndoGroup();
        return ok({ skipped: skipped });
    }

    function renameLayer(argsJson) {
        var args = parseArgs(argsJson);
        var comp = getActiveComp();
        if (!comp) return fail("No active composition.");
        var layer = getFirstSelectedLayer(comp);
        if (!layer) return fail("Select a layer first.");
        var name = args.name;
        if (!name || name === "") return ok({ cancelled: true });
        app.beginUndoGroup("AfterLab: Rename Layer");
        try {
            layer.name = name;
            app.endUndoGroup();
            return ok({ message: "Layer renamed to \"" + name + "\"." });
        } catch (e) {
            app.endUndoGroup();
            return fail(e.toString());
        }
    }

    function duplicate() {
        var comp = getActiveComp();
        if (!comp) return fail("No active composition.");
        var layers = getSelectedLayers(comp);
        if (!layers.length) return fail("Select at least one layer first.");
        app.beginUndoGroup("AfterLab: Duplicate");
        try {
            for (var i = 0; i < layers.length; i++) layers[i].duplicate();
            app.endUndoGroup();
            return ok({ message: "Duplicated " + layers.length + " layer(s)." });
        } catch (e) {
            app.endUndoGroup();
            return fail(e.toString());
        }
    }

    function closeAllComps() {
        if (!app.project) return fail("No project is open.");
        app.beginUndoGroup("AfterLab: Close All Comps");
        try {
            var count = 0;
            for (var i = 1; i <= app.project.numItems; i++) {
                var item = app.project.item(i);
                if (item instanceof CompItem) {
                    try {
                        var viewer = item.openInViewer();
                        if (viewer) { viewer.close(); count++; }
                    } catch (e) {}
                }
            }
            app.endUndoGroup();
            return ok({ message: "Closed " + count + " composition viewer(s)." });
        } catch (e) {
            app.endUndoGroup();
            return fail(e.toString());
        }
    }

    function freezeFrame() {
        var comp = getActiveComp();
        if (!comp) return fail("No active composition.");
        var layer = getFirstSelectedLayer(comp);
        if (!layer) return fail("Select a layer first.");
        app.beginUndoGroup("AfterLab: Freeze Frame");
        try {
            var t = comp.time;
            var workEnd = comp.workAreaStart + comp.workAreaDuration;
            var lastT = workEnd - (1 / comp.frameRate);
            layer.timeRemapEnabled = true;
            var tr = layer.property("Time Remap");
            var frozenValue = tr.valueAtTime(t, false);
            tr.addKey(t);
            var keyIdx = tr.nearestKeyIndex(t);
            tr.setValueAtKey(keyIdx, frozenValue);
            tr.setInterpolationTypeAtKey(keyIdx, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
            if (lastT > t) {
                tr.addKey(lastT);
                var endIdx = tr.nearestKeyIndex(lastT);
                tr.setValueAtKey(endIdx, frozenValue);
                tr.setInterpolationTypeAtKey(endIdx, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
            }
            app.endUndoGroup();
            return ok({ message: "Freeze frame applied." });
        } catch (e) {
            app.endUndoGroup();
            return fail(e.toString());
        }
    }

    function mirrorH() {
        var comp = getActiveComp();
        if (!comp) return fail("No active composition.");
        var layers = getSelectedLayers(comp);
        if (!layers.length) return fail("Select at least one layer first.");
        app.beginUndoGroup("AfterLab: Mirror Horizontal");
        try {
            for (var i = 0; i < layers.length; i++) {
                var s = layers[i].transform.scale.value;
                layers[i].transform.scale.setValue(s.length === 2 ? [-s[0], s[1]] : [-s[0], s[1], s[2]]);
            }
            app.endUndoGroup();
            return ok({ message: "Mirrored horizontal." });
        } catch (e) {
            app.endUndoGroup();
            return fail(e.toString());
        }
    }

    function mirrorV() {
        var comp = getActiveComp();
        if (!comp) return fail("No active composition.");
        var layers = getSelectedLayers(comp);
        if (!layers.length) return fail("Select at least one layer first.");
        app.beginUndoGroup("AfterLab: Mirror Vertical");
        try {
            for (var i = 0; i < layers.length; i++) {
                var s = layers[i].transform.scale.value;
                layers[i].transform.scale.setValue(s.length === 2 ? [s[0], -s[1]] : [s[0], -s[1], s[2]]);
            }
            app.endUndoGroup();
            return ok({ message: "Mirrored vertical." });
        } catch (e) {
            app.endUndoGroup();
            return fail(e.toString());
        }
    }

    function resetTransforms() {
        var comp = getActiveComp();
        if (!comp) return fail("No active composition.");
        var layers = getSelectedLayers(comp);
        if (!layers.length) return fail("Select at least one layer first.");
        var cx = comp.width / 2, cy = comp.height / 2;
        app.beginUndoGroup("AfterLab: Reset Transforms");
        var skipped = [];
        for (var i = 0; i < layers.length; i++) {
            try {
                var xfGroup = getXfGroup(layers[i]);
                setLayerPos(xfGroup, cx, cy, 0);
                var cur = xfGroup.property("ADBE Scale").value;
                xfGroup.property("ADBE Scale").setValue(cur.length === 2 ? [100, 100] : [100, 100, 100]);
                try { xfGroup.property("ADBE Rotate Z").setValue(0); } catch (e) {}
                try { xfGroup.property("ADBE Rotate X").setValue(0); } catch (e) {}
                try { xfGroup.property("ADBE Rotate Y").setValue(0); } catch (e) {}
                xfGroup.property("ADBE Opacity").setValue(100);
            } catch (e) { skipped.push(layers[i].name); }
        }
        app.endUndoGroup();
        return ok({ skipped: skipped });
    }

    function setAnchorPoint(argsJson) {
        var args = parseArgs(argsJson);
        var hPct = args.hPct !== undefined ? args.hPct : 0.5;
        var vPct = args.vPct !== undefined ? args.vPct : 0.5;
        var comp = getActiveComp();
        if (!comp) return fail("No active composition.");
        var layers = getSelectedLayers(comp);
        if (!layers.length) return fail("Select at least one layer first.");
        app.beginUndoGroup("AfterLab: Set Anchor Point");
        var skipped = [];
        for (var i = 0; i < layers.length; i++) {
            try {
                var layer = layers[i];
                if (layer instanceof CameraLayer || layer instanceof LightLayer) {
                    skipped.push(layer.name + " (camera/light layers have no anchor point)");
                    continue;
                }
                var srcW = (layer.source && layer.source.width) ? layer.source.width : comp.width;
                var srcH = (layer.source && layer.source.height) ? layer.source.height : comp.height;
                var newAPX = srcW * hPct, newAPY = srcH * vPct;
                var xfGroup = getXfGroup(layer);
                var apProp = xfGroup.property("ADBE Anchor Point");
                var oldAP = apProp.value;
                var newAP = (oldAP.length === 3) ? [newAPX, newAPY, 0] : [newAPX, newAPY];
                var dx = newAP[0] - oldAP[0], dy = newAP[1] - oldAP[1];
                apProp.setValue(newAP);
                var curScale = xfGroup.property("ADBE Scale").value;
                var sx = curScale[0] / 100, sy = curScale[1] / 100;
                var rotDeg = 0;
                try { rotDeg = xfGroup.property("ADBE Rotate Z").value; } catch (e) {}
                var rotRad = rotDeg * (Math.PI / 180);
                var cosR = Math.cos(rotRad), sinR = Math.sin(rotRad);
                var compDx = dx * sx * cosR - dy * sy * sinR;
                var compDy = dx * sx * sinR + dy * sy * cosR;
                var posProp = xfGroup.property("ADBE Position");
                if (posProp.dimensionsSeparated) {
                    xfGroup.property("ADBE Position_0").setValue(xfGroup.property("ADBE Position_0").value + compDx);
                    xfGroup.property("ADBE Position_1").setValue(xfGroup.property("ADBE Position_1").value + compDy);
                } else {
                    var curPos = posProp.value;
                    if (curPos.length === 2) {
                        posProp.setValue([curPos[0] + compDx, curPos[1] + compDy]);
                    } else {
                        posProp.setValue([curPos[0] + compDx, curPos[1] + compDy, curPos[2]]);
                    }
                }
            } catch (e) { skipped.push(layers[i].name + ": " + e.toString()); }
        }
        app.endUndoGroup();
        return ok({ skipped: skipped });
    }

    function addBGSolid() {
        var comp = getActiveComp();
        if (!comp) return fail("No active composition.");
        app.beginUndoGroup("AfterLab: Add BG Solid");
        try {
            var solid = comp.layers.addSolid(
                [0.08, 0.08, 0.08], DEFAULTS.bgSolidName,
                comp.width, comp.height, comp.pixelAspect, comp.duration
            );
            solid.moveToEnd();
            app.endUndoGroup();
            return ok({ message: "BG solid added." });
        } catch (e) {
            app.endUndoGroup();
            return fail(e.toString());
        }
    }

    function addVignette() {
        var comp = getActiveComp();
        if (!comp) return fail("No active composition.");
        app.beginUndoGroup("AfterLab: Add Vignette");
        try {
            var w = comp.width, h = comp.height;
            var vLayer = comp.layers.addSolid([0, 0, 0], DEFAULTS.vigName, w, h, comp.pixelAspect, comp.duration);
            vLayer.property("Opacity").setValue(70);
            var mask = vLayer.property("Masks").addProperty("Mask");
            var cx = w / 2, cy = h / 2, rx = w * 0.46, ry = h * 0.46, k = 0.5523;
            var shape = new Shape();
            shape.closed = true;
            shape.vertices = [[cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy]];
            shape.inTangents = [[-rx * k, 0], [0, -ry * k], [rx * k, 0], [0, ry * k]];
            shape.outTangents = [[rx * k, 0], [0, ry * k], [-rx * k, 0], [0, -ry * k]];
            mask.property("maskShape").setValue(shape);
            mask.property("maskMode").setValue(MaskMode.SUBTRACT);
            var feather = Math.min(w, h) * 0.32;
            mask.property("maskFeather").setValue([feather, feather]);
            mask.property("maskOpacity").setValue(100);
            app.endUndoGroup();
            return ok({ message: "Vignette layer added." });
        } catch (e) {
            app.endUndoGroup();
            return fail(e.toString());
        }
    }

    function createNullAndParent() {
        var comp = getActiveComp();
        if (!comp) return fail("No active composition.");
        var layers = getSelectedLayers(comp);
        if (!layers.length) return fail("Select at least one layer first.");
        app.beginUndoGroup("AfterLab: Create Null + Parent");
        try {
            var snapshot = [];
            for (var i = 0; i < layers.length; i++) snapshot.push(layers[i]);
            var nullLayer = comp.layers.addNull(comp.duration);
            nullLayer.name = DEFAULTS.nullName;
            try { nullLayer.label = 8; } catch (e) {}
            for (var j = 0; j < snapshot.length; j++) snapshot[j].parent = nullLayer;
            app.endUndoGroup();
            return ok({ message: "Null controller created and parented." });
        } catch (e) {
            app.endUndoGroup();
            return fail(e.toString());
        }
    }

    function addShapeLayer() {
        var comp = getActiveComp();
        if (!comp) return fail("No active composition.");
        app.beginUndoGroup("AfterLab: Add Shape Layer");
        try {
            var sl = comp.layers.addShape();
            sl.name = "Shape Layer";
            var contents = sl.property("Contents");
            var grp = contents.addProperty("ADBE Vector Group");
            var grpCon = grp.property("Contents");
            var rect = grpCon.addProperty("ADBE Vector Shape - Rect");
            rect.property("ADBE Vector Rect Size").setValue([200, 200]);
            rect.property("ADBE Vector Rect Position").setValue([0, 0]);
            var fill = grpCon.addProperty("ADBE Vector Graphic - Fill");
            fill.property("ADBE Vector Fill Color").setValue([0.20, 0.60, 1.00]);
            sl.property("Position").setValue([comp.width / 2, comp.height / 2]);
            app.endUndoGroup();
            return ok({ message: "Shape layer added." });
        } catch (e) {
            app.endUndoGroup();
            return fail(e.toString());
        }
    }

    function gaussianBlur(argsJson) {
        var args = parseArgs(argsJson);
        var comp = getActiveComp();
        if (!comp) return fail("No active composition.");
        var layer = getFirstSelectedLayer(comp);
        if (!layer) return fail("Select a layer first.");
        var amount = parseFloat(args.amount);
        if (isNaN(amount) || amount < 0) return fail("Invalid blur amount.");
        app.beginUndoGroup("AfterLab: Gaussian Blur");
        try {
            var fx = addEffectByMatchName(layer, "ADBE Gaussian Blur 2") ||
                     addEffectByMatchName(layer, "ADBE Gaussian Blur");
            if (!fx) { app.endUndoGroup(); return fail("Gaussian Blur effect not available."); }
            try { fx.property("Blurriness").setValue(amount); } catch (e) {
                try { fx.property(1).setValue(amount); } catch (e2) {}
            }
            try { fx.property("Repeat Edge Pixels").setValue(true); } catch (e) {}
            app.endUndoGroup();
            return ok({ message: "Gaussian Blur (" + amount + "px) applied." });
        } catch (e) {
            app.endUndoGroup();
            return fail(e.toString());
        }
    }

    function cameraLensBlur() {
        var comp = getActiveComp();
        if (!comp) return fail("No active composition.");
        var layer = getFirstSelectedLayer(comp);
        if (!layer) return fail("Select a layer first.");
        app.beginUndoGroup("AfterLab: Camera Lens Blur");
        try {
            var fx = addEffectByMatchName(layer, "ADBE Camera Lens Blur");
            if (fx) {
                try { fx.property("Blur Radius").setValue(25); } catch (e) {
                    try { fx.property(1).setValue(25); } catch (e2) {}
                }
                app.endUndoGroup();
                return ok({ message: "Camera Lens Blur applied." });
            } else {
                var fallback = addEffectByMatchName(layer, "ADBE Box Blur2") ||
                               addEffectByMatchName(layer, "ADBE Fast Blur");
                if (fallback) {
                    try { fallback.property(1).setValue(25); } catch (e) {}
                    app.endUndoGroup();
                    return ok({ message: "Fast Box Blur applied (Camera Lens Blur not available).", warn: true });
                } else {
                    app.endUndoGroup();
                    return fail("No blur effect available. Please update After Effects.");
                }
            }
        } catch (e) {
            app.endUndoGroup();
            return fail(e.toString());
        }
    }

    function applyFlowEase(argsJson) {
        var args = parseArgs(argsJson);
        var x1 = parseFloat(args.x1), y1 = parseFloat(args.y1), x2 = parseFloat(args.x2), y2 = parseFloat(args.y2);

        if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) return fail("Invalid curve values.");
        // x stays in [0,1] so exact edge handles (0/1) are preserved.
    // y is allowed outside [0,1] to represent overshoot/undershoot curves.
        x1 = Math.max(0, Math.min(1, x1));
    y1 = Math.max(-0.5, Math.min(1.5, y1));
        x2 = Math.max(0, Math.min(1, x2));
    y2 = Math.max(-0.5, Math.min(1.5, y2));

        var comp = getActiveComp();
        if (!comp) return fail("No active composition.");

        var props = comp.selectedProperties || [];
        var targets = [];

        for (var p = 0; p < props.length; p++) {
            try {
                if (props[p] && props[p].propertyType === PropertyType.PROPERTY && props[p].numKeys > 0) {
                    targets.push(props[p]);
                }
            } catch (e) {}
        }

        if (!targets.length) {
            var layers = getSelectedLayers(comp);
            for (var l = 0; l < layers.length; l++) {
                var t = getXfGroup(layers[l]);
                if (!t) continue;
                var candidates = [
                    t.property("ADBE Position"),
                    t.property("ADBE Scale"),
                    t.property("ADBE Rotate Z"),
                    t.property("ADBE Rotate X"),
                    t.property("ADBE Rotate Y"),
                    t.property("ADBE Opacity")
                ];
                for (var c = 0; c < candidates.length; c++) {
                    if (candidates[c] && candidates[c].numKeys > 0) targets.push(candidates[c]);
                }
            }
        }

        if (!targets.length) {
            return fail("Select animated properties/keyframes first.");
        }

        var outInfluence = Math.max(0.1, Math.min(100, x1 * 100));
        var inInfluence  = Math.max(0.1, Math.min(100, (1 - x2) * 100));

        // Compute normalized tangent slopes with L'Hôpital fallback for degenerate 0/0 cases.
        // The standard formula slope = dy/dx breaks down when both numerator and denominator → 0.
        // For the outgoing side (t→0): slope = y1/x1.
        //   Degenerate: x1≈0 && y1≈0 → second-order limit gives y2/x2.
        //   Degenerate: x1≈0 && y1>0  → near-vertical tangent, use large slope.
        // For the incoming side (t→1): slope = (1-y2)/(1-x2).
        //   Degenerate: (1-x2)≈0 && (1-y2)≈0 → second-order limit gives (1-y1)/(1-x1).
        //   Degenerate: (1-x2)≈0 && (1-y2)>0  → near-vertical tangent, use large slope.
        var TANG_EPS = 0.000001;
        // Weighted midpoint: stronger than 0.002, softer than 0.001.
        var SOFT_EDGE_X = 0.0015;
        var MAX_SLOPE_FACTOR = 1000;
        var outSlope;
        if (x1 > TANG_EPS) {
            outSlope = y1 / x1;
        } else if (y1 > TANG_EPS) {
            // Soft vertical fallback: strong but finite slope (Flow-like behavior).
            outSlope = y1 / SOFT_EDGE_X;
        } else {
            // x1≈0 and y1≈0 – handle at origin; second-order L'Hôpital → slope ≈ y2/x2
            outSlope = (x2 > TANG_EPS) ? (y2 / x2) : 1;
        }
        if (!isFinite(outSlope) || outSlope < 0) outSlope = 0;
        outSlope = Math.min(MAX_SLOPE_FACTOR, outSlope);

        var ix = 1 - x2, iy = 1 - y2;
        var inSlope;
        if (ix > TANG_EPS) {
            inSlope = iy / ix;
        } else if (iy > TANG_EPS) {
            // Soft vertical fallback: strong but finite slope (Flow-like behavior).
            inSlope = iy / SOFT_EDGE_X;
        } else {
            // x2≈1 and y2≈1 – handle at endpoint; second-order L'Hôpital → slope ≈ (1-y1)/(1-x1)
            var ix0 = 1 - x1;
            inSlope = (ix0 > TANG_EPS) ? ((1 - y1) / ix0) : 1;
        }
        if (!isFinite(inSlope) || inSlope < 0) inSlope = 0;
        inSlope = Math.min(MAX_SLOPE_FACTOR, inSlope);

        app.beginUndoGroup("AfterLab: Apply Flow Ease");
        var keyCount = 0;
        var propCount = 0;

        try {
            for (var i = 0; i < targets.length; i++) {
                var prop = targets[i];
                if (!prop || prop.numKeys <= 0) continue;

                var dimCount = propertyDimensionCount(prop);
                if (dimCount <= 0) continue;

                var selectedKeys = [];
                try { selectedKeys = prop.selectedKeys || []; } catch (e) {}

                var keys = [];
                if (selectedKeys.length > 0) {
                    for (var sk = 0; sk < selectedKeys.length; sk++) keys.push(selectedKeys[sk]);
                } else {
                    for (var k = 1; k <= prop.numKeys; k++) keys.push(k);
                }

                if (!keys.length) continue;

                for (var kk = 0; kk < keys.length; kk++) {
                    var keyIndex = keys[kk];
                    var speedOutBase = 0;
                    var speedInBase = 0;

                    if (keyIndex < prop.numKeys) speedOutBase = safeKeySpeed(prop, keyIndex, keyIndex + 1);
                    else if (keyIndex > 1) speedOutBase = safeKeySpeed(prop, keyIndex - 1, keyIndex);

                    if (keyIndex > 1) speedInBase = safeKeySpeed(prop, keyIndex - 1, keyIndex);
                    else if (keyIndex < prop.numKeys) speedInBase = safeKeySpeed(prop, keyIndex, keyIndex + 1);

                    // Speed is property-units/sec in AE. Cap relatively (vs base speed), not absolutely.
                    var speedOutMax = Math.max(100, speedOutBase * MAX_SLOPE_FACTOR);
                    var speedInMax = Math.max(100, speedInBase * MAX_SLOPE_FACTOR);
                    var speedOut = Math.max(0, Math.min(speedOutMax, speedOutBase * outSlope));
                    var speedIn = Math.max(0, Math.min(speedInMax, speedInBase * inSlope));

                    var easeOutArr = [];
                    var easeInArr = [];
                    for (var d = 0; d < dimCount; d++) {
                        easeOutArr.push(new KeyframeEase(speedOut, outInfluence));
                        easeInArr.push(new KeyframeEase(speedIn, inInfluence));
                    }

                    try {
                        prop.setInterpolationTypeAtKey(keyIndex, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
                    } catch (e) {}

                    try { prop.setTemporalAutoBezierAtKey(keyIndex, false); } catch (e) {}
                    try { prop.setTemporalContinuousAtKey(keyIndex, false); } catch (e) {}

                    try {
                        prop.setTemporalEaseAtKey(keyIndex, easeInArr, easeOutArr);
                        keyCount++;
                    } catch (e) {}
                }

                propCount++;
            }

            app.endUndoGroup();
            if (keyCount === 0) return fail("No keyframes were updated. Select keyframes on supported properties.");
            return ok({ message: "Applied Flow curve to " + keyCount + " keyframe(s) across " + propCount + " propert(ies)." });
        } catch (e) {
            app.endUndoGroup();
            return fail(e.toString());
        }
    }

    // ── Macros ────────────────────────────────────────────────────────────────

    function captureMacro(argsJson) {
        var args = parseArgs(argsJson);
        var slotIndex = parseInt(args.slotIndex, 10);
        if (isNaN(slotIndex) || slotIndex < 0 || slotIndex > 7) return fail("Invalid slot index.");
        var comp = getActiveComp();
        if (!comp) return fail("No active composition.");
        var layer = getFirstSelectedLayer(comp);
        if (!layer) return fail("Select a layer first.");
        var effects = getMacroSourceEffects(layer);
        if (!effects.length) return fail("The selected layer has no effects to capture.");
        var snapshots = [];
        for (var i = 0; i < effects.length; i++) snapshots.push(snapshotEffect(effects[i]));
        MACRO_SLOTS[slotIndex] = snapshots;
        return ok({ filled: true, count: snapshots.length, message: "Captured " + snapshots.length + " effect(s) into M" + (slotIndex + 1) + "." });
    }

    function applyMacro(argsJson) {
        var args = parseArgs(argsJson);
        var slotIndex = parseInt(args.slotIndex, 10);
        if (isNaN(slotIndex) || slotIndex < 0 || slotIndex > 7) return fail("Invalid slot index.");
        var slot = MACRO_SLOTS[slotIndex];
        if (!slot || !slot.length) return fail("M" + (slotIndex + 1) + " is empty. Alt-click to capture effects first.");
        var comp = getActiveComp();
        if (!comp) return fail("No active composition.");
        var layers = getSelectedLayers(comp);
        var targets = [];
        app.beginUndoGroup("AfterLab: Apply Macro M" + (slotIndex + 1));
        try {
            if (!layers || !layers.length) {
                targets.push(createAdjustmentLayer(comp, "Adjustment Layer M" + (slotIndex + 1)));
            } else {
                for (var i = 0; i < layers.length; i++) targets.push(layers[i]);
            }
            for (var t = 0; t < targets.length; t++) {
                for (var j = 0; j < slot.length; j++) applyEffectSnapshotToLayer(targets[t], slot[j]);
            }
            app.endUndoGroup();
            return ok({ message: "Applied M" + (slotIndex + 1) + " to " + targets.length + " layer(s)." });
        } catch (e) {
            app.endUndoGroup();
            return fail(e.toString());
        }
    }

    function clearMacro(argsJson) {
        var args = parseArgs(argsJson);
        var slotIndex = parseInt(args.slotIndex, 10);
        if (isNaN(slotIndex) || slotIndex < 0 || slotIndex > 7) return fail("Invalid slot index.");
        MACRO_SLOTS[slotIndex] = null;
        return ok({ filled: false, message: "M" + (slotIndex + 1) + " cleared." });
    }

    function getMacroStates() {
        var states = [];
        for (var i = 0; i < 8; i++) states.push({ filled: !!(MACRO_SLOTS[i] && MACRO_SLOTS[i].length) });
        return ok({ states: states });
    }

    function getSelectedCompFromProjectPanel() {
        try {
            if (!app.project || !app.project.selection || app.project.selection.length === 0) return null;
            for (var i = 0; i < app.project.selection.length; i++) {
                if (app.project.selection[i] instanceof CompItem) return app.project.selection[i];
            }
        } catch (e) {}
        return null;
    }

    function getProjectInfo() {
        var comp = getSelectedCompFromProjectPanel() || getActiveComp();
        var compName = "No active comp";
        var compSize = "No active comp";
        var frameRate = "-";

        if (comp) {
            try { compName = comp.name; } catch (e) {}
            try { compSize = comp.width + " × " + comp.height; } catch (e) {}
            try { frameRate = (Math.round(comp.frameRate * 100) / 100) + " fps"; } catch (e) {}
        }

        var lastSaved = "Unsaved project";
        var lastSavedMs = null;
        var projectName = "Unsaved project";
        try {
            if (app.project && app.project.file) {
                var projectFile = app.project.file;
                if (projectFile && projectFile.exists) {
                    try { projectName = projectFile.name; } catch (e0) {}
                    if (projectFile.modified) {
                        lastSaved = projectFile.modified.toString();
                        try { lastSavedMs = projectFile.modified.getTime(); } catch (e1) {}
                    } else {
                        lastSaved = projectFile.fsName;
                    }
                }
            }
        } catch (e) {}

        return ok({
            compName: compName,
            compSize: compSize,
            frameRate: frameRate,
            lastSaved: lastSaved,
            lastSavedMs: lastSavedMs,
            projectName: projectName
        });
    }

    // ─────────────────────────────────────────────────────────────────────────

    return {
        preCompose:         preCompose,
        centerLayers:       centerLayers,
        saveFrame:          saveFrame,
        addAdjLayer:        addAdjLayer,
        addCamera:          addCamera,
        addSolid:           addSolid,
        addNull:            addNull,
        trimToTime:         trimToTime,
        renameLayer:        renameLayer,
        duplicate:          duplicate,
        closeAllComps:      closeAllComps,
        freezeFrame:        freezeFrame,
        mirrorH:            mirrorH,
        mirrorV:            mirrorV,
        resetTransforms:    resetTransforms,
        setAnchorPoint:     setAnchorPoint,
        addBGSolid:         addBGSolid,
        addVignette:        addVignette,
        createNullAndParent: createNullAndParent,
        addShapeLayer:      addShapeLayer,
        gaussianBlur:       gaussianBlur,
        cameraLensBlur:     cameraLensBlur,
        applyFlowEase:      applyFlowEase,
        captureMacro:       captureMacro,
        applyMacro:         applyMacro,
        clearMacro:         clearMacro,
        getMacroStates:     getMacroStates,
        getProjectInfo:     getProjectInfo
    };

}());
